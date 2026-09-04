// AUTO-PUSH — the ONE way a session's work reaches the base branch. No
// background git, no PR: commit everything, merge base in, fix conflicts,
// verify against the repo, push the branch (the backup), then a plain
// fast-forward push of the merged branch to base. Base moved meanwhile? merge
// again — up to ROUNDS times, then give up with the branch intact on origin
// and nothing on base.
//
// A plain merge, deliberately not a squash: a squash puts a NEW commit on
// base whose content is the branch's work but which the branch does not
// contain, so the next merge of base into the branch collides with the
// session's own earlier work — every re-edited line a false conflict, the
// fixer resolving the session against itself. Sharing history costs only
// cosmetics on base's log and lets a session auto-push any number of times.
//
// No lock: one user drives this — you don't auto-push while an agent is
// mid-write, and a true simultaneous git op just errors on git's own
// index.lock. No time limit anywhere — the fixer is bounded by attempts and
// its own maxSteps.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, type WorkspaceRow, type SessionRow } from '../db/schema.js';
import { resolveAuth } from '../pool/pool.js';
import { repoDir, type Paths } from '../pool/paths.js';
import { getFolder } from '../sessions.js';
import { git, mergeBase, pushSession, pushToBase } from './git.js';
import { verifyResolved } from './gitFixer.js';
import { commitMessageFor } from './commitMessage.js';
import type { ModelConfig } from '../../core/llm/createAgent.js';
import { logger, errStr } from '../log.js';

const log = logger('auto-push');

const ROUNDS = 3;

export interface AutoPushEvent { step: 'commit' | 'merge' | 'fix' | 'verify' | 'push_branch' | 'push_base' | 'retry'; detail?: string }

export interface AutoPushResult {
  result: 'pushed' | 'nothing' | 'blocked' | 'error';
  reason?: string;
  rounds?: number;
  /** The commit that landed on base (pushed only). */
  sha?: string;
}

export interface AutoPushDeps {
  db: Db;
  paths: Paths;
  encryptionKey: Buffer;
  /** Conflict agent hook — same shape the engine's pull uses. Resolves +
   *  commits in the workspace container, no credentials; auto-push verifies
   *  against the repo afterward. Absent -> a conflict blocks. */
  fixer?: (session: SessionRow, workspace: WorkspaceRow, dir: string) => Promise<boolean>;
  /** Model for the commit message (the Git Fixer's config). null / absent ->
   *  the file-name fallback. */
  messageConfig?: () => Promise<ModelConfig | null>;
  /** Progress, one event per step — awaited, so a streaming route can write
   *  in order (and tests can inject races). */
  onEvent?: (e: AutoPushEvent) => void | Promise<void>;
}

export async function autoPush(deps: AutoPushDeps, session: SessionRow, workspace: WorkspaceRow): Promise<AutoPushResult> {
  const folder = session.folderId ? await getFolder(deps.db, session.folderId) : undefined;
  if (!folder) return { result: 'error' as const, reason: 'session has no folder — nothing to push' };
  const dir = repoDir(deps.paths, folder.id);
  const base = workspace.baseBranch;
  const auth = await resolveAuth(deps.db, workspace, deps.encryptionKey);
  const ev = async (step: AutoPushEvent['step'], detail?: string) => { await deps.onEvent?.({ step, detail }); };

  // 1 — commit everything. Nothing to commit: skip.
  const { stdout: dirty } = await git(dir, ['status', '--porcelain']);
  if (dirty.trim()) {
    await ev('commit');
    await git(dir, ['add', '-A']);
    const config = deps.messageConfig ? await deps.messageConfig().catch(() => null) : null;
    const msg = await commitMessageFor(dir, config);
    await git(dir, ['commit', '--no-verify', '-m', `${msg}\n\nPhantom-Session: ${session.id}`]);
  }

  for (let round = 1; round <= ROUNDS; round++) {
    // 2 — merge origin/<base> into the branch (mergeBase fetches first).
    await ev('merge', `round ${round}`);
    const { result: merged } = await mergeBase(dir, base, auth);
    if (merged === 'conflict') {
      // 3 — the Git Fixer, on this directory.
      await ev('fix');
      const fixed = deps.fixer
        ? await deps.fixer(session, workspace, dir).catch((e) => {
            log.error({ session: session.id, err: errStr(e) }, 'git fixer threw'); return false;
          })
        : false;
      if (!fixed || !(await verifyResolved(dir, base))) {
        await git(dir, ['merge', '--abort']).catch(() => {});
        log.warn({ session: session.id, round }, 'auto-push: conflict unresolved — branch left as it was');
        return { result: 'blocked' as const, reason: 'merge conflict left unresolved', rounds: round };
      }
    } else if (merged !== 'clean' && merged !== 'merged') {
      // dirty_tree cannot happen (step 1 committed everything);
      // diverged/error are real failures.
      return { result: 'error' as const, reason: `merge failed (${merged})`, rounds: round };
    }

    // 4 — verify against the repo, never against any claim: clean tree, no
    // unmerged entries, origin/<base> an ancestor of HEAD.
    await ev('verify');
    if (!(await verifyResolved(dir, base))) {
      await git(dir, ['merge', '--abort']).catch(() => {});
      return { result: 'blocked' as const, reason: 'verification failed after merge', rounds: round };
    }

    // Nothing beyond base -> nothing to push (an empty session, or base
    // already holds it all).
    const { stdout: ahead } = await git(dir, ['rev-list', '--count', `origin/${base}..HEAD`]);
    if (Number(ahead.trim()) === 0) return { result: 'nothing' as const, rounds: round };

    // 5 — push the branch: the backup. If base later has to be reverted,
    // the work is still here.
    await ev('push_branch');
    const pushed = await pushSession(dir, folder.branch, auth);
    if (pushed !== 'pushed') {
      return { result: 'error' as const, reason: `branch push failed (${pushed})`, rounds: round };
    }
    await deps.db.update(sessions).set({ lastPushAt: new Date() }).where(eq(sessions.id, session.id));

    // 6 — the landing: HEAD to base, fast-forward by construction.
    await ev('push_base');
    const landed = await pushToBase(dir, base, auth);
    if (landed === 'pushed') {
      const { stdout: sha } = await git(dir, ['rev-parse', 'HEAD']);
      log.info({ session: session.id, base, rounds: round }, 'pushed');
      return { result: 'pushed' as const, rounds: round, sha: sha.trim() };
    }
    if (landed === 'error') return { result: 'error' as const, reason: 'push to base failed', rounds: round };
    // 7 — base moved between our merge and our push. The fixer's work is
    // already committed on the branch; merge again from there.
    await ev('retry', `${base} moved`);
  }
  // 8 — give up. Nothing on base, branch intact on origin.
  return { result: 'blocked' as const, reason: `${base} kept moving — ${ROUNDS} rounds spent`, rounds: ROUNDS };
}
