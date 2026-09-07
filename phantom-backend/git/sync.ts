// THE SYNC — the one flow that puts a session's work on top of the base branch.
// Auto-push and auto-pull are the SAME operation asking the same question —
// how do I get base's new commits under my work — and they had two answers
// until they were folded together here. Auto-pull is auto-push without the
// last step. The only real difference is `landOnBase`.
//
// REBASE, not merge. Three reasons, in order:
//   - The landing is a plain commit on base. A merge hides its resolution
//     inside a merge commit, which commit-by-commit review skips — so a
//     resolution that dropped code someone else landed is invisible, and git
//     never raises those lines again. This holds for a PULL too: a bad
//     resolution sits on the branch and the next auto-push squashes and lands
//     it. "A pull lands nothing" is false; it lands everything, later.
//   - Direction of loss. Merging base INTO the branch makes "keep the current
//     side" mean "throw away what arrived on base". A rebase stands on base and
//     replays the session's work over it.
//   - The push to base is a fast-forward by construction.
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
// THE LOCK is the only concurrency test. The sync takes the session lock and
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

const log = logger('git-sync');

/** Rounds exist only for the landing: base can move between our rebase and our
 *  fast-forward. Nothing races a pull — base moving after it is simply the next
 *  pull — so a sync that does not land runs one round. */
const ROUNDS = 3;
/** The hold, and the beat it is renewed on. A conflict turn is a full coding
 *  turn — it outlives any fixed TTL, so the hold must be renewed or another
 *  writer walks in mid-rebase. */
export const LOCK_TTL_MS = 120_000;
export const RENEW_MS = 45_000;

export type SyncStep =
  | 'lock' | 'backup' | 'commit' | 'rebase' | 'resolve' | 'verify'
  | 'push_branch' | 'push_base' | 'retry';

export interface SyncEvent { step: SyncStep; detail?: string }

/** Everything the coding agent is told about a stopped rebase. `arrived` is the
 *  log of what landed on base — the briefing that separates resolving a
 *  conflict from guessing at one. */
export interface ConflictContext {
  branch: string;
  baseBranch: string;
  files: string[];
  arrived: string[];
}

export interface SyncResult {
  /** ok = the work is on top of base and the branch is pushed (and, when
   *  landing, base is fast-forwarded) · nothing = there was nothing to do ·
   *  blocked = a conflict the agent could not resolve, tree left as it was ·
   *  busy = someone else holds the session · error = git failed. */
  outcome: 'ok' | 'nothing' | 'blocked' | 'busy' | 'error';
  reason?: string;
  rounds?: number;
  /** HEAD after the replay (ok only). */
  sha?: string;
  /** `<short sha> <subject>` of every base commit that came in. */
  arrived?: string[];
  /** Files the replay changed in the working tree (ok only). */
  files?: string[];
  /** Whether the branch reached origin (ok only). */
  pushed?: boolean;
}

export interface SyncDeps {
  db: Db;
  paths: Paths;
  encryptionKey: Buffer;
  /** Hand the stopped rebase to the session's own coding agent, as a turn in
   *  its own transcript. Resolves, stages and continues the rebase; the sync
   *  verifies against the repo afterward. Absent -> a conflict blocks.
   *
   *  The sync already holds the session when this runs, under GIT_CLIENT_ID, so
   *  the hook's own openSession re-takes our hold rather than finding us. */
  resolve?: (session: SessionRow, workspace: WorkspaceRow, dir: string, ctx: ConflictContext) => Promise<boolean>;
  /** Model for the commit message (the assistant's). null / absent -> the
   *  file-name fallback. */
  messageConfig?: () => Promise<ModelConfig | null>;
  /** Progress, one event per step — awaited, so a streaming route can write
   *  in order (and tests can inject races). */
  onEvent?: (e: SyncEvent) => void | Promise<void>;
}

export interface SyncOptions {
  /** Fast-forward base to the result. False is a pull: the branch catches up
   *  and nothing reaches base. */
  landOnBase: boolean;
  /** What a person sees while the session is held. */
  label: string;
  /** Stop with `nothing` when base has not moved, even if the session has work.
   *  True for a pull — a no-op pull must mint no commit and spend no model
   *  call. False for a push, which lands local work whether or not base moved. */
  onlyWhenBaseMoved: boolean;
}

export async function syncBranch(
  deps: SyncDeps, session: SessionRow, workspace: WorkspaceRow, opts: SyncOptions,
): Promise<SyncResult> {
  const folder = session.folderId ? await getFolder(deps.db, session.folderId) : undefined;
  if (!folder) return { outcome: 'error', reason: 'session has no folder — nothing to sync' };
  const dir = repoDir(deps.paths, folder.id);
  const base = workspace.baseBranch;
  const auth = await resolveAuth(deps.db, workspace, deps.encryptionKey);
  const ev = async (step: SyncStep, detail?: string) => { await deps.onEvent?.({ step, detail }); };
  const rounds = opts.landOnBase ? ROUNDS : 1;

  // 0 — the lock IS the concurrency test. Held by someone else means someone
  // else is writing this checkout; there is nothing further to check.
  await ev('lock');
  if (!(await acquireLock(deps.db, session, GIT_CLIENT_ID, LOCK_TTL_MS, opts.label))) {
    return { outcome: 'busy', reason: 'the session is busy — try again when its turn finishes' };
  }
  const heartbeat = setInterval(() => {
    void renewLock(deps.db, session.id, GIT_CLIENT_ID, LOCK_TTL_MS)
      .catch((e) => log.warn({ session: session.id, err: errStr(e) }, 'lock renewal failed'));
  }, RENEW_MS);

  try {
    // 1 — what is on base that we do not have. Collected before anything is
    // rewritten, and carried into the conflict turn as the briefing.
    let arrived = await fetchBase(dir, base, auth);
    if (opts.onlyWhenBaseMoved && arrived.length === 0) return { outcome: 'nothing', arrived: [] };

    // 2 — the backup, BEFORE any rewrite. A rebase rewrites the branch and the
    // push that follows forces; this plain push is the copy that force cannot
    // reach, and it is also what gives --force-with-lease a fresh ref to hold.
    await ev('backup');
    const backed = await pushSession(dir, folder.branch, auth);
    if (backed === 'error') return { outcome: 'error', reason: 'could not back the branch up — nothing was rewritten' };

    // 3 — stage everything and collapse it to one commit's worth of content.
    // The message is written AFTER the squash: it is built from the staged
    // diff, which only shows the whole session's work once HEAD is back at the
    // merge base.
    if (await stageAndSquash(dir, base)) {
      await ev('commit');
      const config = deps.messageConfig ? await deps.messageConfig().catch(() => null) : null;
      const card = await cardIntentFor(deps.db, session, workspace);
      const msg = await commitMessageFor(dir, config, card);
      await commitStaged(dir, `${msg}\n\nPhantom-Session: ${session.id}`);
    } else if (!opts.onlyWhenBaseMoved) {
      // A push with no work of its own and nothing behind has nothing to do. A
      // pull reaching here HAS something to do: base moved (step 1 said so).
      const { stdout: behind } = await git(dir, ['rev-list', '--count', `HEAD..origin/${base}`]);
      if (Number(behind.trim()) === 0) return { outcome: 'nothing', arrived };
    }
    const before = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();

    for (let round = 1; round <= rounds; round++) {
      // 4 — replay onto base. Round 2+ re-fetches; there is no second squash
      // and no second commit message, because there is still just one commit.
      if (round > 1) arrived = await fetchBase(dir, base, auth);
      await ev('rebase', `round ${round}`);
      const rebased = await rebaseOntoBase(dir, base);

      if (rebased === 'conflict') {
        // 5 — the session's own coding agent, in its own transcript.
        const { stdout: conflicted } = await git(dir, ['diff', '--name-only', '--diff-filter=U']);
        const ctx: ConflictContext = {
          branch: folder.branch, baseBranch: base,
          files: conflicted.trim().split('\n').filter(Boolean), arrived,
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
          log.warn({ session: session.id, round }, 'sync: conflict unresolved — branch left as it was');
          return { outcome: 'blocked', reason: 'the rebase conflict was left unresolved', rounds: round };
        }
      } else if (rebased === 'error') {
        await rebaseAbort(dir);
        return { outcome: 'error', reason: 'the rebase could not start', rounds: round };
      }

      // 6 — verify against the repo: clean tree, no unmerged entries, no rebase
      // still in flight, origin/<base> in HEAD's history.
      await ev('verify');
      if (!(await verifyLanded(dir, base))) {
        await rebaseAbort(dir);
        return { outcome: 'blocked', reason: 'verification failed after the rebase', rounds: round };
      }

      // 7 — the branch, rewritten by the rebase, so this forces with a lease.
      await ev('push_branch');
      const pushed = await pushSessionForced(dir, folder.branch, auth);
      if (pushed === 'pushed') {
        await deps.db.update(sessions).set({ lastPushAt: new Date() }).where(eq(sessions.id, session.id));
      } else if (opts.landOnBase) {
        // The backup must exist before base is touched.
        return { outcome: 'error', reason: `branch push failed (${pushed})`, rounds: round };
      }

      const sha = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
      const { stdout: changed } = await git(dir, ['diff', '--name-only', before, 'HEAD']);
      const done: SyncResult = {
        outcome: 'ok', rounds: round, sha, arrived,
        files: changed.trim().split('\n').filter(Boolean),
        pushed: pushed === 'pushed',
        ...(pushed !== 'pushed' ? { reason: `synced, but the branch push failed (${pushed})` } : {}),
      };
      if (!opts.landOnBase) {
        log.info({ session: session.id, base, arrived: arrived.length, pushed }, 'pulled base');
        return done;
      }

      // Nothing beyond base -> nothing to land (base already holds it all).
      const { stdout: ahead } = await git(dir, ['rev-list', '--count', `origin/${base}..HEAD`]);
      if (Number(ahead.trim()) === 0) return { outcome: 'nothing', rounds: round, arrived };

      // 8 — the landing: HEAD to base, fast-forward by construction.
      await ev('push_base');
      const landed = await pushToBase(dir, base, auth);
      if (landed === 'pushed') {
        log.info({ session: session.id, base, rounds: round }, 'pushed');
        return done;
      }
      if (landed === 'error') return { outcome: 'error', reason: 'push to base failed', rounds: round };
      // 9 — base moved between our rebase and our push. The resolution is
      // already in the branch's one commit; replay it again from there.
      await ev('retry', `${base} moved`);
    }
    // 10 — give up. Nothing on base, branch intact on origin.
    return { outcome: 'blocked', reason: `${base} kept moving — ${ROUNDS} rounds spent`, rounds: ROUNDS };
  } catch (e) {
    log.error({ session: session.id, err: errStr(e) }, 'sync failed');
    await rebaseAbort(dir);
    return { outcome: 'error', reason: (e as Error).message };
  } finally {
    clearInterval(heartbeat);
    await releaseLock(deps.db, session.id, GIT_CLIENT_ID);
  }
}
