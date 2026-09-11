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
  git, fetchBase, squashToMergeBase, commitStaged, rebaseOntoBase, rebaseAbort,
  landingProblems, pushSession, pushSessionForced, pushToBase, hasWorkToLand, GIT_CLIENT_ID,
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
  /** Append a summary of the sync to the session's transcript — a user message
   *  the agent picks up on its next turn. Same lock (GIT_CLIENT_ID), same
   *  openSession pattern as `resolve`. Absent -> no summary is recorded. */
  recordSummary?: (session: SessionRow, workspace: WorkspaceRow, result: SyncResult, opts: SyncOptions) => Promise<void>;
  /** Model for the commit message (the assistant's). A throw or a null fails
   *  the sync with the reason — there is no file-name fallback: base history
   *  only ever gets a real message. `report` is the retry loop's voice
   *  (withRetry): each failed attempt and the final give-up, as they happen
   *  — hand it to the config's onRetry or the wait is invisible. */
  messageConfig?: (report?: (note: string) => void) => Promise<ModelConfig | null>;
  /** Progress, one event per step — awaited, so a streaming route can write
   *  in order (and tests can inject races). */
  onEvent?: (e: SyncEvent) => void | Promise<void>;
}

export interface SyncOptions {
  /** Fast-forward base to the result. False is a pull: the branch catches up
   *  and nothing reaches base.
   *
   *  This one bit is the whole difference between the two directions, and it
   *  answers three questions at once — whether to push to base, what "nothing
   *  to do" means (a push has nothing to LAND, a pull has nothing to CATCH UP
   *  to), and whether rounds are worth running. */
  landOnBase: boolean;
  /** What a person sees while the session is held. */
  label: string;
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

    // Is there anything to do? Asked ONCE, before anything is written, so an
    // idle run mints no commit and spends no model call. A push has nothing to
    // do when the session has no work; a pull has nothing to do when base has
    // not moved — the same question, read from each direction.
    const idle = opts.landOnBase ? !(await hasWorkToLand(dir, base)) : arrived.length === 0;
    if (idle) return { outcome: 'nothing', arrived };

    // 2 — the backup, BEFORE any rewrite. A rebase rewrites the branch and the
    // push that follows forces; this plain push is the copy that force cannot
    // reach, and it is also what gives --force-with-lease a fresh ref to hold.
    await ev('backup');
    const backed = await pushSession(dir, folder.branch, auth);
    if (backed === 'error') return { outcome: 'error', reason: 'could not back the branch up — nothing was rewritten' };

    // 3 — the commit. The message is written BEFORE anything is rewritten:
    // stage everything, build the message from the staged diff against the
    // merge-base (the whole session's work, HEAD still put), and only then
    // squash and commit. A message that cannot be written FAILS the sync
    // here — no commit, no squash, the index put back, nothing moved — and
    // the reason is the provider's own words. A silent file-name fallback
    // just hid a dead provider and guaranteed it stayed dead.
    // False in the gate means a pull with nothing of its own — base moved but
    // the session has not touched anything. The replay below is then a plain
    // fast-forward, which is exactly what that pull wants.
    if (await hasWorkToLand(dir, base)) {
      await ev('commit');
      try {
        await git(dir, ['add', '-A']);
        const { stdout: mb } = await git(dir, ['merge-base', 'HEAD', `origin/${base}`]);
        // Retry notes stream as commit-step events, so a rate-limited message
        // call shows its recovery (and its give-up) where the sync's progress
        // already shows — silence here was the original bug.
        const config = deps.messageConfig
          ? await deps.messageConfig((note) => { void ev('commit', note); })
          : null;
        const card = await cardIntentFor(deps.db, session, workspace);
        const msg = await commitMessageFor(dir, config, card, mb.trim(), deps.db, session.id);
        await squashToMergeBase(dir, mb.trim());
        await commitStaged(dir, `${msg}\n\nPhantom-Session: ${session.id}`);
      } catch (e) {
        await git(dir, ['reset', '-q']).catch(() => {}); // index back to HEAD; the tree was never touched
        return { outcome: 'error', reason: `could not write the commit message: ${(e as Error).message}` };
      }
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
        // --abort` read as the failure it is. A block names exactly which
        // check failed — the person (and the next attempt) gets the truth.
        const problems = ok ? await landingProblems(dir, base) : [];
        if (!ok || problems.length > 0) {
          await rebaseAbort(dir);
          const reason = !ok
            ? 'the conflict resolution turn could not run — the session may be busy or the agent failed'
            : `the conflict was not resolved — ${problems.join('; ')}`;
          log.warn({ session: session.id, round, reason }, 'sync: conflict unresolved — branch left as it was');
          return { outcome: 'blocked', reason, rounds: round };
        }
      } else if (rebased === 'error') {
        await rebaseAbort(dir);
        return { outcome: 'error', reason: 'the rebase could not start', rounds: round };
      }

      // 6 — verify against the repo: clean tree, no unmerged entries, no
      // rebase still in flight, origin/<base> in HEAD's history — named.
      await ev('verify');
      const failed = await landingProblems(dir, base);
      if (failed.length > 0) {
        await rebaseAbort(dir);
        return { outcome: 'blocked', reason: `verification failed after the rebase — ${failed.join('; ')}`, rounds: round };
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
        await deps.recordSummary?.(session, workspace, done, opts).catch((e) =>
          log.warn({ session: session.id, err: errStr(e) }, 'could not record sync summary'));
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
        await deps.recordSummary?.(session, workspace, done, opts).catch((e) =>
          log.warn({ session: session.id, err: errStr(e) }, 'could not record sync summary'));
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
