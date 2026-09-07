// AUTO-PULL — bring origin/<base> INTO the session branch, on demand, in one
// operation: fetch, commit the session's work if the tree is dirty, merge base
// in, resolve conflicts, verify against the repo, push the branch (the backup).
// Nothing lands on base — that is auto-push's job (autoPush.ts); this is its
// mirror in the other direction, and it is the ONE way an agent or the
// Assistant pulls (the agent's own git in the container carries no
// credentials and has no resolver).
//
// Auto-pull still MERGES while auto-push rebases: it lands nothing on base, so
// it has no reason to rewrite the branch. Its resolver is the same coding-agent
// turn. docs/auto-pull.md is the plan for the rest.
//
// Commit first, never stash: `merge --autostash` keeps the stash unapplied
// while a conflicted merge is open, and re-applying it after the fixer has
// resolved the tree is a SECOND conflict surface the fixer never sees (git-merge
// docs: "the final stash application ... might result in non-trivial
// conflicts"). A commit on an append-only branch costs nothing — auto-push
// would have made it anyway.
//
// No rounds: nothing races a pull — base moving after our merge is simply the
// next pull. No lock, no time limit — the same rules as auto-push.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, type WorkspaceRow, type SessionRow } from '../db/schema.js';
import { resolveAuth } from '../pool/pool.js';
import { repoDir, type Paths } from '../pool/paths.js';
import { getFolder } from '../sessions.js';
import { git, mergeBase, pushSession, verifyLanded } from './git.js';
import type { ConflictContext } from './autoPush.js';
import { commitMessageFor } from './commitMessage.js';
import type { ModelConfig } from '../../core/llm/createAgent.js';
import { logger, errStr } from '../log.js';

const log = logger('auto-pull');

export interface AutoPullEvent { step: 'fetch' | 'commit' | 'merge' | 'fix' | 'verify' | 'push_branch'; detail?: string }

export interface AutoPullResult {
  /** merged = base came in · clean = nothing to pull · blocked = a conflict
   *  the fixer could not resolve (tree left as it was) · error = git failed. */
  result: 'merged' | 'clean' | 'blocked' | 'error';
  reason?: string;
  /** `<short sha> <subject>` of every base commit that came in (merged only). */
  arrived?: string[];
  /** Files the merge changed in the working tree (merged only). */
  files?: string[];
  /** HEAD after the merge (merged only). */
  sha?: string;
  /** Whether the branch backup reached origin (merged only). false = the
   *  merge is in, the push is not — the result is still a sync. */
  pushed?: boolean;
}

export interface AutoPullDeps {
  db: Db;
  paths: Paths;
  encryptionKey: Buffer;
  /** Hand the stopped merge to the session's own coding agent — the same hook
   *  auto-push and manual pull use, with `mode: 'merge'`. It resolves and
   *  commits in the workspace container, holding no credentials; auto-pull
   *  verifies against the repo afterward. Absent -> a conflict blocks.
   *
   *  Auto-pull takes NO lock of its own, so this hook's own openSession is what
   *  takes it — a turn already running makes the resolve fail and the pull
   *  block, rather than two writers in one checkout. See docs/auto-pull.md. */
  resolve?: (session: SessionRow, workspace: WorkspaceRow, dir: string, ctx: ConflictContext) => Promise<boolean>;
  /** Model for the commit message (the assistant's). null / absent ->
   *  the file-name fallback. */
  messageConfig?: () => Promise<ModelConfig | null>;
  /** Progress, one event per step — awaited, so a streaming route can write
   *  in order. */
  onEvent?: (e: AutoPullEvent) => void | Promise<void>;
}

export async function autoPull(deps: AutoPullDeps, session: SessionRow, workspace: WorkspaceRow): Promise<AutoPullResult> {
  const folder = session.folderId ? await getFolder(deps.db, session.folderId) : undefined;
  if (!folder) return { result: 'error', reason: 'session has no folder — nothing to pull into' };
  const dir = repoDir(deps.paths, folder.id);
  const base = workspace.baseBranch;
  const auth = await resolveAuth(deps.db, workspace, deps.encryptionKey);
  const ev = async (step: AutoPullEvent['step'], detail?: string) => { await deps.onEvent?.({ step, detail }); };

  try {
    // 1 — is there anything to pull? Asked BEFORE committing, so a no-op pull
    // never mints a commit or spends a model call on its message. mergeBase
    // (step 3) fetches again — a no-op round trip, deliberately: its
    // fetch+count+merge is one primitive shared with auto-push and manual
    // pull, and it stays whole. Do not fold the two fetches.
    await ev('fetch');
    await git(dir, ['fetch', 'origin', base], auth);
    const { stdout: behind } = await git(dir, ['rev-list', '--count', `HEAD..origin/${base}`]);
    if (Number(behind.trim()) === 0) return { result: 'clean' };

    // 2 — commit everything the session has in flight (auto-push's rule).
    const { stdout: dirty } = await git(dir, ['status', '--porcelain']);
    if (dirty.trim()) {
      await ev('commit');
      await git(dir, ['add', '-A']);
      const config = deps.messageConfig ? await deps.messageConfig().catch(() => null) : null;
      const msg = await commitMessageFor(dir, config);
      await git(dir, ['commit', '--no-verify', '-m', `${msg}\n\nPhantom-Session: ${session.id}`]);
    }
    const { stdout: before } = await git(dir, ['rev-parse', 'HEAD']);

    // 3 — merge origin/<base> in.
    await ev('merge');
    const { result: merged, arrived } = await mergeBase(dir, base, auth,
      `Merge origin/${base} into ${folder.branch}\n\nPhantom-Session: ${session.id}`);
    if (merged === 'conflict') {
      // 4 — the session's own coding agent, on this directory, in its own
      // transcript. It merges rather than rebases here: a pull lands nothing,
      // so it has no reason to rewrite the branch.
      await ev('fix');
      const { stdout: conflicted } = await git(dir, ['diff', '--name-only', '--diff-filter=U']);
      const ctx: ConflictContext = {
        mode: 'merge', branch: folder.branch, baseBranch: base,
        files: conflicted.trim().split('\n').filter(Boolean), arrived: arrived ?? [],
      };
      const fixed = deps.resolve
        ? await deps.resolve(session, workspace, dir, ctx).catch((e) => {
            log.error({ session: session.id, err: errStr(e) }, 'conflict turn threw'); return false;
          })
        : false;
      if (!fixed || !(await verifyLanded(dir, base))) {
        await git(dir, ['merge', '--abort']).catch(() => {});
        log.warn({ session: session.id }, 'auto-pull: conflict unresolved — branch left as it was');
        return { result: 'blocked', reason: 'merge conflict left unresolved — the branch is as it was before the pull' };
      }
    } else if (merged !== 'merged') {
      // clean cannot happen (step 1 saw commits behind); dirty_tree cannot
      // (step 2 committed everything); diverged/error are real failures.
      return { result: 'error', reason: `merge failed (${merged})` };
    }

    // 5 — verify against the repo, never against any claim.
    await ev('verify');
    if (!(await verifyLanded(dir, base))) {
      await git(dir, ['merge', '--abort']).catch(() => {});
      return { result: 'blocked', reason: 'verification failed after merge' };
    }
    const { stdout: sha } = await git(dir, ['rev-parse', 'HEAD']);
    const { stdout: files } = await git(dir, ['diff', '--name-only', `${before.trim()}..HEAD`]);

    // 6 — push the branch: the backup, so the resolution never lives on one
    // disk only. The merge is the result; a failed push does not undo it.
    await ev('push_branch');
    const pushed = await pushSession(dir, folder.branch, auth);
    if (pushed === 'pushed') {
      await deps.db.update(sessions).set({ lastPushAt: new Date() }).where(eq(sessions.id, session.id));
    }
    log.info({ session: session.id, base, arrived: arrived?.length, pushed }, 'pulled base');
    return {
      result: 'merged', sha: sha.trim(),
      arrived: arrived ?? [],
      files: files.trim().split('\n').filter(Boolean),
      pushed: pushed === 'pushed',
      ...(pushed !== 'pushed' ? { reason: `merged, but the branch push failed (${pushed})` } : {}),
    };
  } catch (e) {
    log.error({ session: session.id, err: errStr(e) }, 'auto-pull failed');
    return { result: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}
