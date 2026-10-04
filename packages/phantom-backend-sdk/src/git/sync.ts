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
import type { ProjectRow, SessionRow } from '../storage/schema.js';
import * as checkoutPool from '../runtime/CheckoutPool.js';
import { repoDir, type Paths } from '../lib/paths.js';
import type { Sessions } from '../storage/Sessions.js';
import type { Workspaces } from '../storage/Workspaces.js';
import type { Cards } from '../storage/Cards.js';
import type { Settings } from '../storage/Settings.js';
import {
  git, fetchBase, squashToMergeBase, commitStaged, rebaseOntoBase, rebaseAbort, rebaseInProgress,
  landingProblems, pushSession, pushSessionForced, pushToBase, hasWorkToLand, GIT_CLIENT_ID,
} from './Git.js';
import { newId } from 'phantom-client-sdk';
import { logger, errStr } from '../lib/log.js';

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

/** Each step in words, as every screen shows it (the cli's status line,
 *  Telegram, the session feed). Named here, where the step is born, so no
 *  client keeps its own copy. `commit` reads differently on a pull. */
export function syncStepLabel(step: SyncStep, landOnBase: boolean): string {
  switch (step) {
    case 'lock': return 'taking the session';
    case 'backup': return 'backing the branch up';
    case 'commit': return landOnBase ? 'committing' : 'committing this session\'s work';
    case 'rebase': return 'replaying the work on the base branch';
    case 'resolve': return 'Fix Conflicts';
    case 'verify': return 'verifying against the repo';
    case 'push_branch': return 'pushing the branch';
    case 'push_base': return 'pushing to the base branch';
    case 'retry': return 'base moved — replaying again';
  }
}

export interface SyncEvent { step: SyncStep; label: string; detail?: string }

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
  /** ok: files the replay changed in the working tree. blocked with no
   *  fixer: the files that conflicted (the rebase is left in progress). */
  files?: string[];
  /** Whether the branch reached origin (ok only). */
  pushed?: boolean;
}

/** The card a coding session is building, as one line for the commit
 *  message: "title — first line of details". A diff says what changed and
 *  never why, and this is the cheapest statement of why the system holds.
 *
 *  Fails open to the session's name — a session may be on no card, the card
 *  may be deleted, and NONE of that may stop work from landing. The commit
 *  message simply loses its intent line. */
async function cardIntentFor(deps: SyncDeps, session: SessionRow): Promise<string> {
  try {
    const card = await deps.cards.ofSession(session.id);
    if (!card?.title) return session.name ?? '';
    const firstLine = (card.details ?? '').trim().split('\n')[0] ?? '';
    return firstLine ? `${card.title} — ${firstLine}` : card.title;
  } catch (error) {
    log.debug({ session: session.id, err: errStr(error) }, 'card intent unavailable — commit message goes without it');
    return session.name ?? '';
  }
}

export interface SyncDeps {
  sessions: Sessions;
  workspaces: Workspaces;
  cards: Cards;
  settings: Settings;
  paths: Paths;
  /** Hand the stopped rebase to the session's own coding agent, as a turn in
   *  its own transcript. Resolves, stages and continues the rebase; the sync
   *  verifies against the repo afterward. Absent -> a conflict blocks.
   *
   *  The sync already holds the session when this runs, under GIT_CLIENT_ID, so
   *  the hook's own openSession re-takes our hold rather than finding us. */
  resolve?: (session: SessionRow, project: ProjectRow, dir: string, ctx: ConflictContext) => Promise<boolean>;
  /** Append a summary of the sync to the session's transcript — a user message
   *  the agent picks up on its next turn. Same lock (GIT_CLIENT_ID), same
   *  openSession pattern as `resolve`. Absent -> no summary is recorded. */
  recordSummary?: (session: SessionRow, project: ProjectRow, result: SyncResult, opts: SyncOptions) => Promise<void>;
  /** Model for the commit message (the assistant's). A throw or a null fails
   *  the sync with the reason — there is no file-name fallback: base history
   *  only ever gets a real message. `report` is the retry loop's voice
   *  (withRetry): each failed attempt and the final give-up, as they happen
   *  — hand it to the config's onRetry or the wait is invisible. */
  /** The commit's subject line from the staged diff: `stat` and `diff`
   *  (capped) against the merge-base, the card's intent, and `report` for
   *  each retry note (shown as a commit-step event). A model call — the
   *  app's until the backend writes it on the client SDK's billed model.
   *  Absent, or throwing: the sync fails with the reason; nothing guesses. */
  writeCommitMessage?: (input: { stat: string; diff: string; card: string; sessionId: string }, report: (note: string) => void) => Promise<string>;
  /** Progress, one event per step — awaited, so a streaming route can write
   *  in order (and tests can inject races). */
  onEvent?: (event: SyncEvent) => void | Promise<void>;
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
  /** Take the SESSION for the run (default) — no turn runs while the sync
   *  does. False is instant sync's mode: the sync runs whenever, turn or no
   *  turn, and hands nothing to the session — so it must also run without
   *  `resolve`; a conflict is left in progress and reported, never handed to
   *  a turn. The CHECKOUT lock is taken either way. */
  hold?: boolean;
}

export async function syncBranch(
  deps: SyncDeps, session: SessionRow, project: ProjectRow, opts: SyncOptions,
): Promise<SyncResult> {
  const workspace = session.workspaceId ? await deps.workspaces.get(session.workspaceId) : undefined;
  if (!workspace) return { outcome: 'error', reason: 'session has no workspace — nothing to sync' };
  const dir = repoDir(deps.paths, workspace.id);
  const base = project.baseBranch;
  const auth = await checkoutPool.resolveAuth(deps.settings, project);
  const report = async (step: SyncStep, detail?: string) => { await deps.onEvent?.({ step, label: syncStepLabel(step, opts.landOnBase), detail }); };
  const rounds = opts.landOnBase ? ROUNDS : 1;
  const hold = opts.hold ?? true;

  // A rebase an instant sync left stopped for the agent: its markers are in
  // the files. Staging them (`add -A`) would commit them as resolved and
  // the abort below would throw the agent's work away — so no sync runs
  // here until the agent finishes it.
  if (await rebaseInProgress(dir)) {
    return { outcome: 'blocked', reason: 'a rebase is in progress in this checkout — resolve it first' };
  }

  // 0 — the locks ARE the concurrency test. The CHECKOUT lock first, always:
  // one sync writes a checkout at a time, whoever asked (Workspaces owns it;
  // fresh id per run, never re-entered). Then, when holding, the SESSION
  // lock: no turn runs under the sync. Held by someone else means someone
  // else is writing; there is nothing further to check.
  await report('lock');
  const holder = newId();
  if (!(await deps.workspaces.acquireSyncLock(workspace.id, holder, LOCK_TTL_MS))) {
    return { outcome: 'busy', reason: 'another sync is writing this checkout — try again when it finishes' };
  }
  if (hold && !(await deps.sessions.acquireLock(session, GIT_CLIENT_ID, LOCK_TTL_MS, opts.label))) {
    await deps.workspaces.releaseSyncLock(workspace.id, holder);
    return { outcome: 'busy', reason: 'the session is busy — try again when its turn finishes' };
  }
  const heartbeat = setInterval(() => {
    void deps.workspaces.renewSyncLock(workspace.id, holder, LOCK_TTL_MS)
      .catch((error) => log.warn({ workspace: workspace.id, err: errStr(error) }, 'checkout lock renewal failed'));
    if (hold) {
      void deps.sessions.renewLock(session.id, GIT_CLIENT_ID, LOCK_TTL_MS)
        .catch((error) => log.warn({ session: session.id, err: errStr(error) }, 'lock renewal failed'));
    }
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
    // push that follows forces; this push is the copy of HEAD as it stands
    // now. Plain when origin's copy is behind; forced (with the lease) when
    // origin holds an OLDER REWRITE of this branch — a sync whose forced push
    // never ran, or a rebase the agent finished itself after a conflict was
    // left for it. Origin's copy is then history HEAD has already replaced;
    // folding it back in (a merge) re-creates the conflict it came from.
    await report('backup');
    const backed = await pushSession(dir, workspace.branch, auth);
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
      await report('commit');
      try {
        await git(dir, ['add', '-A']);
        const { stdout: mergeBase } = await git(dir, ['merge-base', 'HEAD', `origin/${base}`]);
        // Retry notes stream as commit-step events, so a rate-limited message
        // call shows its recovery (and its give-up) where the sync's progress
        // already shows — silence here was the original bug.
        const card = await cardIntentFor(deps, session);
        const msg = await commitMessageFromDiff(dir, mergeBase.trim(), card, session.id, deps.writeCommitMessage, (note) => { void report('commit', note); });
        await squashToMergeBase(dir, mergeBase.trim());
        await commitStaged(dir, `${msg}\n\nPhantom-Session: ${session.id}`);
      } catch (error) {
        await git(dir, ['reset', '-q']).catch(() => {}); // index back to HEAD; the tree was never touched
        return { outcome: 'error', reason: `could not write the commit message: ${(error as Error).message}` };
      }
    }
    const before = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();

    for (let round = 1; round <= rounds; round++) {
      // 4 — replay onto base. Round 2+ re-fetches; there is no second squash
      // and no second commit message, because there is still just one commit.
      if (round > 1) arrived = await fetchBase(dir, base, auth);
      await report('rebase', `round ${round}`);
      const rebased = await rebaseOntoBase(dir, base);

      if (rebased === 'conflict') {
        // 5 — the session's own coding agent, in its own transcript.
        const { stdout: conflicted } = await git(dir, ['diff', '--name-only', '--diff-filter=U']);
        const ctx: ConflictContext = {
          branch: workspace.branch, baseBranch: base,
          files: conflicted.trim().split('\n').filter(Boolean), arrived,
        };
        // No fixer (instant sync): the rebase is LEFT STOPPED, markers in the
        // files, for the agent to resolve in place at its next turn — the
        // note carries the files. Instant sync stays off the checkout while
        // the rebase is in progress.
        if (!deps.resolve) {
          const reason = `conflict in ${ctx.files.join(', ')} — left for the agent to resolve`;
          log.warn({ session: session.id, round, files: ctx.files }, 'sync: conflict left in progress for the agent');
          const blocked: SyncResult = { outcome: 'blocked', reason, rounds: round, arrived, files: ctx.files };
          await deps.recordSummary?.(session, project, blocked, opts).catch((error) =>
            log.warn({ session: session.id, err: errStr(error) }, 'could not record sync summary'));
          return blocked;
        }
        await report('resolve', ctx.files.join(', '));
        const ok = await deps.resolve(session, project, dir, ctx).catch((error) => {
          log.error({ session: session.id, err: errStr(error) }, 'conflict turn threw'); return false;
        });
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
      await report('verify');
      const failed = await landingProblems(dir, base);
      if (failed.length > 0) {
        await rebaseAbort(dir);
        return { outcome: 'blocked', reason: `verification failed after the rebase — ${failed.join('; ')}`, rounds: round };
      }

      // 7 — the branch, rewritten by the rebase, so this forces with a lease.
      await report('push_branch');
      const pushed = await pushSessionForced(dir, workspace.branch, auth);
      if (pushed === 'pushed') {
        await deps.workspaces.markPushed(workspace.id);
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
        await deps.recordSummary?.(session, project, done, opts).catch((error) =>
          log.warn({ session: session.id, err: errStr(error) }, 'could not record sync summary'));
        return done;
      }

      // Nothing beyond base -> nothing to land (base already holds it all).
      const { stdout: ahead } = await git(dir, ['rev-list', '--count', `origin/${base}..HEAD`]);
      if (Number(ahead.trim()) === 0) return { outcome: 'nothing', rounds: round, arrived };

      // 8 — the landing: HEAD to base, fast-forward by construction.
      await report('push_base');
      const landed = await pushToBase(dir, base, auth);
      if (landed === 'pushed') {
        log.info({ session: session.id, base, rounds: round }, 'pushed');
        await deps.recordSummary?.(session, project, done, opts).catch((error) =>
          log.warn({ session: session.id, err: errStr(error) }, 'could not record sync summary'));
        return done;
      }
      if (landed === 'error') return { outcome: 'error', reason: 'push to base failed', rounds: round };
      // 9 — base moved between our rebase and our push. The resolution is
      // already in the branch's one commit; replay it again from there.
      await report('retry', `${base} moved`);
    }
    // 10 — give up. Nothing on base, branch intact on origin.
    return { outcome: 'blocked', reason: `${base} kept moving — ${ROUNDS} rounds spent`, rounds: ROUNDS };
  } catch (error) {
    log.error({ session: session.id, err: errStr(error) }, 'sync failed');
    await rebaseAbort(dir);
    return { outcome: 'error', reason: (error as Error).message };
  } finally {
    clearInterval(heartbeat);
    if (hold) await deps.sessions.releaseLock(session.id, GIT_CLIENT_ID);
    await deps.workspaces.releaseSyncLock(workspace.id, holder);
  }
}

const MAX_DIFF_BYTES = 60_000;
/** The staged diff against `base` (stat + patch, the patch capped), handed
 *  to the message writer. Throws when none is wired or none can be written:
 *  the sync's answer is to fail, not to guess. */
async function commitMessageFromDiff(
  dir: string, base: string, card: string, sessionId: string,
  write: SyncDeps['writeCommitMessage'], report: (note: string) => void,
): Promise<string> {
  if (!write) throw new Error('no model configured to write the commit message — set one on /settings (phantom-cli), or PATCH /settings {coding_provider, coding_model}');
  const { stdout: stat } = await git(dir, ['diff', '--cached', '--stat', base]);
  const { stdout: patch } = await git(dir, ['diff', '--cached', base]);
  const diff = patch.length > MAX_DIFF_BYTES ? `${patch.slice(0, MAX_DIFF_BYTES)}\n… (truncated)` : patch;
  const message = (await write({ stat, diff, card, sessionId }, report)).trim();
  if (!message || message.length > 2000) throw new Error('the model could not produce a usable commit message');
  return message;
}
