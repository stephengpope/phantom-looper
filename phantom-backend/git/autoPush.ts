// AUTO-PUSH — the ONE way a session's work reaches the base branch. No
// background git, no PR: take the lock, back the branch up, squash the session
// to one commit, REBASE it onto the base branch, hand a stopped rebase to the
// session's own coding agent, verify against the repo, force-push the branch
// with a lease, then a fast-forward push to base. Base moved meanwhile? rebase
// again — up to ROUNDS times, then give up with the branch intact on origin
// and nothing on base.
//
// REBASE, not merge. Three reasons, in order:
//   - The landing is a plain commit on base. A merge hides its resolution
//     inside a merge commit, which commit-by-commit review skips — so a
//     resolution that dropped code someone else landed is invisible, and git
//     never raises those lines again.
//   - Direction of loss. Merging base INTO the branch makes "keep the current
//     side" mean "throw away what arrived on base". A rebase stands on base and
//     replays the session's work over it.
//   - The push to base is a fast-forward by construction, same as before.
// The usual objection — never rewrite a published branch — does not apply: one
// session owns its branch start to finish and nothing else ever pulls it. The
// real cost is that the backup on origin gets rewritten, which is why the
// backup push happens BEFORE anything rewrites anything.
//
// SQUASH FIRST, and that is the whole reason the squash exists. Replaying N
// commits stops N times, over intermediate trees that never existed as a
// working state, re-resolving the same hunks. One commit stops at most once,
// over the session's finished work. It costs the step-by-step history on base;
// the detail lives in the transcript and on the backup ref.
//
// THE RESOLVER IS THE CODING AGENT. Not a separate fixer: the agent that wrote
// the code is the author, it already carries the card and its own reasoning,
// the resolution lands in the session's own transcript, and it learns that its
// files changed under it — which a side process could never tell it. It holds
// no credentials; resolving a conflict is editing files.
//
// THE LOCK is the only concurrency test. Auto-push takes the session lock and
// fails when it cannot; it never inspects whether anything is running. Same
// single lock the rest of the system uses — no new mutex.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, type WorkspaceRow, type SessionRow } from '../db/schema.js';
import { resolveAuth } from '../pool/pool.js';
import { repoDir, type Paths } from '../pool/paths.js';
import { getFolder, acquireLock, releaseLock, renewLock, cardIntentFor } from '../sessions.js';
import {
  git, fetchBase, stageAndSquash, commitStaged, rebaseOntoBase, rebaseAbort,
  verifyLanded, pushSession, pushSessionForced, pushToBase, GIT_CLIENT_ID,
} from './git.js';
import { commitMessageFor } from './commitMessage.js';
import type { ModelConfig } from '../../core/llm/createAgent.js';
import { logger, errStr } from '../log.js';

const log = logger('auto-push');

const ROUNDS = 3;
/** The hold auto-push takes, and the beat it renews on. A conflict turn is a
 *  full coding turn — it outlives any fixed TTL, so the hold must be renewed
 *  or another writer walks in mid-rebase. */
export const LOCK_TTL_MS = 120_000;
export const RENEW_MS = 45_000;

export interface AutoPushEvent {
  step: 'lock' | 'backup' | 'commit' | 'rebase' | 'resolve' | 'verify' | 'push_branch' | 'push_base' | 'retry';
  detail?: string;
}

export interface AutoPushResult {
  result: 'pushed' | 'nothing' | 'blocked' | 'busy' | 'error';
  reason?: string;
  rounds?: number;
  /** The commit that landed on base (pushed only). */
  sha?: string;
}

/** Everything the coding agent is told about a stopped rebase. `arrived` is the
 *  log of what landed on base — the briefing that separates resolving a
 *  conflict from guessing at one. */
export interface ConflictContext {
  /** How the conflict arose, and therefore how it must be finished: auto-push
   *  rebases and continues, auto-pull merges and commits. */
  mode: 'rebase' | 'merge';
  branch: string;
  baseBranch: string;
  files: string[];
  arrived: string[];
}

export interface AutoPushDeps {
  db: Db;
  paths: Paths;
  encryptionKey: Buffer;
  /** Hand the stopped rebase to the session's own coding agent, as a turn in
   *  its own transcript. Resolves, stages and continues the rebase; auto-push
   *  verifies against the repo afterward. Absent -> a conflict blocks. */
  resolve?: (session: SessionRow, workspace: WorkspaceRow, dir: string, ctx: ConflictContext) => Promise<boolean>;
  /** Model for the commit message (the assistant's). null / absent -> the
   *  file-name fallback. */
  messageConfig?: () => Promise<ModelConfig | null>;
  /** Progress, one event per step — awaited, so a streaming route can write
   *  in order (and tests can inject races). */
  onEvent?: (e: AutoPushEvent) => void | Promise<void>;
  /** The client id auto-push holds the session under. The resolver MUST open
   *  the session under this same id or it will find the session locked by us. */
  client: string;
}

export async function autoPush(deps: AutoPushDeps, session: SessionRow, workspace: WorkspaceRow): Promise<AutoPushResult> {
  const folder = session.folderId ? await getFolder(deps.db, session.folderId) : undefined;
  if (!folder) return { result: 'error' as const, reason: 'session has no folder — nothing to push' };
  const dir = repoDir(deps.paths, folder.id);
  const base = workspace.baseBranch;
  const auth = await resolveAuth(deps.db, workspace, deps.encryptionKey);
  const ev = async (step: AutoPushEvent['step'], detail?: string) => { await deps.onEvent?.({ step, detail }); };

  // 0 — the lock IS the concurrency test. Held by someone else means someone
  // else is writing this checkout; there is nothing further to check.
  await ev('lock');
  if (!(await acquireLock(deps.db, session, deps.client, LOCK_TTL_MS, 'auto-push'))) {
    return { result: 'busy' as const, reason: 'the session is busy — try again when its turn finishes' };
  }
  const heartbeat = setInterval(() => {
    void renewLock(deps.db, session.id, deps.client, LOCK_TTL_MS)
      .catch((e) => log.warn({ session: session.id, err: errStr(e) }, 'lock renewal failed'));
  }, RENEW_MS);

  try {
    // 1 — what is on base that we do not have. Collected before anything is
    // rewritten, and carried into the conflict turn as the briefing.
    let arrived = await fetchBase(dir, base, auth);

    // 2 — the backup, BEFORE any rewrite. A rebase rewrites the branch and the
    // push that follows forces; this plain push is the copy that force cannot
    // reach, and it is also what gives --force-with-lease a fresh ref to hold.
    await ev('backup');
    const backed = await pushSession(dir, folder.branch, auth);
    if (backed === 'error') return { result: 'error' as const, reason: 'could not back the branch up — nothing was rewritten' };

    // 3 — stage everything and collapse it to one commit's worth of content.
    // The message is written AFTER the squash: it is built from the staged
    // diff, which only shows the whole session's work once HEAD is back at the
    // merge base.
    if (!(await stageAndSquash(dir, base))) {
      return { result: 'nothing' as const };
    }
    await ev('commit');
    const config = deps.messageConfig ? await deps.messageConfig().catch(() => null) : null;
    const card = await cardIntentFor(deps.db, session, workspace);
    const msg = await commitMessageFor(dir, config, card);
    await commitStaged(dir, `${msg}\n\nPhantom-Session: ${session.id}`);

    for (let round = 1; round <= ROUNDS; round++) {
      // 4 — replay onto base. Round 2+ re-fetches; there is no second squash
      // and no second commit message, because there is still just one commit.
      if (round > 1) arrived = await fetchBase(dir, base, auth);
      await ev('rebase', `round ${round}`);
      const rebased = await rebaseOntoBase(dir, base);

      if (rebased === 'conflict') {
        // 5 — the session's own coding agent, in its own transcript.
        const { stdout: files } = await git(dir, ['diff', '--name-only', '--diff-filter=U']);
        const ctx: ConflictContext = {
          mode: 'rebase', branch: folder.branch, baseBranch: base,
          files: files.trim().split('\n').filter(Boolean), arrived,
        };
        await ev('resolve', ctx.files.join(', '));
        const ok = deps.resolve
          ? await deps.resolve(session, workspace, dir, ctx).catch((e) => {
              log.error({ session: session.id, err: errStr(e) }, 'conflict turn threw'); return false;
            })
          : false;
        // Verified against the repo, never against what the agent said. The
        // rebase-in-progress and ancestor checks are what make a `rebase
        // --abort` read as the failure it is.
        if (!ok || !(await verifyLanded(dir, base))) {
          await rebaseAbort(dir);
          log.warn({ session: session.id, round }, 'auto-push: conflict unresolved — branch left as it was');
          return { result: 'blocked' as const, reason: 'the rebase conflict was left unresolved', rounds: round };
        }
      } else if (rebased === 'error') {
        await rebaseAbort(dir);
        return { result: 'error' as const, reason: 'the rebase could not start', rounds: round };
      }

      // 6 — verify against the repo: clean tree, no unmerged entries, no rebase
      // still in flight, origin/<base> in HEAD's history.
      await ev('verify');
      if (!(await verifyLanded(dir, base))) {
        await rebaseAbort(dir);
        return { result: 'blocked' as const, reason: 'verification failed after the rebase', rounds: round };
      }

      // Nothing beyond base -> nothing to push (base already holds it all).
      const { stdout: ahead } = await git(dir, ['rev-list', '--count', `origin/${base}..HEAD`]);
      if (Number(ahead.trim()) === 0) return { result: 'nothing' as const, rounds: round };

      // 7 — the branch, rewritten by the rebase, so this forces with a lease.
      await ev('push_branch');
      const pushed = await pushSessionForced(dir, folder.branch, auth);
      if (pushed !== 'pushed') {
        return { result: 'error' as const, reason: `branch push failed (${pushed})`, rounds: round };
      }
      await deps.db.update(sessions).set({ lastPushAt: new Date() }).where(eq(sessions.id, session.id));

      // 8 — the landing: HEAD to base, fast-forward by construction.
      await ev('push_base');
      const landed = await pushToBase(dir, base, auth);
      if (landed === 'pushed') {
        const { stdout: sha } = await git(dir, ['rev-parse', 'HEAD']);
        log.info({ session: session.id, base, rounds: round }, 'pushed');
        return { result: 'pushed' as const, rounds: round, sha: sha.trim() };
      }
      if (landed === 'error') return { result: 'error' as const, reason: 'push to base failed', rounds: round };
      // 9 — base moved between our rebase and our push. The resolution is
      // already in the branch's one commit; replay it again from there.
      await ev('retry', `${base} moved`);
    }
    // 10 — give up. Nothing on base, branch intact on origin.
    return { result: 'blocked' as const, reason: `${base} kept moving — ${ROUNDS} rounds spent`, rounds: ROUNDS };
  } catch (e) {
    log.error({ session: session.id, err: errStr(e) }, 'auto-push failed');
    await rebaseAbort(dir);
    return { result: 'error' as const, reason: (e as Error).message };
  } finally {
    clearInterval(heartbeat);
    await releaseLock(deps.db, session.id, deps.client);
  }
}
