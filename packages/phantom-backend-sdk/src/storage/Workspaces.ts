// The workspace row's one owner. A workspace is a checkout: the files on disk, the
// branch, the container. The directory on disk is named by this id (which
// equals the owning session's id). The row is permanent: it is what
// remembers the branch; the FILES can be deleted (`removeFiles`) and
// re-cloned from it (`restore`).
//
// The checkout itself is made here (`checkout` / `restore`): claim a warm
// pool slot or clone, cut the branch, read the commit it was cut from. ONE
// branch, start to finish: it is checked out at creation, worked in,
// committed to, and pushed back to. Nothing is ever pushed anywhere else.
// The branch is always the owning session's {prefix}/{id}, cut from the base
// branch, and recorded on the row, so it is decided once and never re-derived.
//
// Every fact about the checkout lives here (036): whether the files exist,
// when it was last touched, when its branch last reached origin, its git
// state. Sessions read them through their workspace_id (Sessions.view), so a
// supervisor's or the assistant's activity counts for the coder's checkout
// the same as the coder's own.
//
// Events: the workspace's id IS its owning session's id, so a write here
// publishes on that session's feed — a bare `session` record ("this row
// moved") for the list, `work` with its value for the watcher's dot.
import fs from 'node:fs/promises';
import { and, eq, inArray, isNotNull, isNull, lt, not, or, count } from 'drizzle-orm';
import type { Drizzle } from './Database.js';
import { workspaces, sessions, cards, type WorkspaceRow, type ProjectRow } from '../storage/schema.js';
import type { SessionEvents } from '../agents/SessionEvents.js';
import type { Settings } from './Settings.js';
import { git, cloneFresh, checkoutBranch, classifyGitFailure, localState, type WorkState } from '../git/Git.js';
import { claimSlot, resolveAuth } from '../runtime/CheckoutPool.js';
import { sessionDir, repoDir, type Paths } from '../lib/paths.js';
import { logger } from '../lib/log.js';

const log = logger('workspaces');

/** A checkout's own refusal: the remote said no in a way a person can act on
 *  (a dead token, a repo it cannot see, GitHub unreachable, a source branch
 *  that never reached origin), or the files hold work nobody pushed. */
export class WorkspaceError extends Error {
  constructor(public code: string, message: string, public retryable = false) { super(message); }
}

/** A workspace as the work-state refresh walks it: what the git read needs,
 *  plus the card number its board event is named by. */
export interface WorkRefreshWorkspace {
  id: string; projectId: string; branch: string; work: string | null; card: number | null;
}

export class Workspaces {
  constructor(
    private readonly db: Drizzle,
    private readonly paths: Paths,
    private readonly settings: Settings,
    /** The per-session feed; absent in tests that have no watchers. */
    private readonly events?: SessionEvents,
  ) {}

  private changed(id: string): void { this.events?.publish(id, '', { event: 'session' }); }

  async get(id: string): Promise<WorkspaceRow | undefined> {
    const rows = await this.db.select().from(workspaces).where(eq(workspaces.id, id));
    return rows[0];
  }

  // ── the files ──────────────────────────────────────────────────────────────

  /** Put the files on disk for `id` on `branch`: claim a warm pool slot or
   *  clone directly — ONE way to obtain a checkout, not a fast path for some
   *  callers and a slow one for others (the claim's fetch is what makes the
   *  result CORRECT; the pool only makes it small) — then check the branch
   *  out: found on origin (a restart), cut from `fromBranch` (a duplicate),
   *  or cut fresh from base. Returns HEAD afterwards and how it went.
   *
   *  A missing `fromBranch` is a hard error, never a silent fall back to
   *  base: the caller flushed the source to origin first, so absent means
   *  something is wrong, and a copy that quietly starts at base loses the
   *  work. A remote failure is classified into a WorkspaceError so the API
   *  answers with its meaning; anything unrecognised keeps its own error. */
  private async obtain(project: ProjectRow, id: string, branch: string, fromBranch?: string):
  Promise<{ head: string; found: 'existing' | 'new'; claimed: boolean }> {
    const dest = sessionDir(this.paths, id);
    const dir = repoDir(this.paths, id);
    const auth = await resolveAuth(this.settings, project);
    try {
      const claimed = await claimSlot(this.paths, project.owner, project.name, project.baseBranch, dest);
      if (claimed) {
        // Pool slots are pristine by construction, so the unguarded catch-up is
        // safe — and mandatory: a slot stocked days ago is days behind.
        await git(dir, ['fetch', 'origin', project.baseBranch], auth);
        await git(dir, ['reset', '--hard', `origin/${project.baseBranch}`]);
      } else {
        const depth = await this.settings.resolve<string>('initial_history_depth', { projectId: project.id });
        await cloneFresh(dir, auth, project.baseBranch, depth);
        await fs.mkdir(`${dest}/scratch`, { recursive: true });
      }
      await fs.mkdir(`${dest}/logs`, { recursive: true }); // detached exec logs — outside repo/, or add -A commits them

      // --depth implies --single-branch: the clone's fetch refspec covers ONLY the
      // base branch, so without this a push to the session branch would update no
      // tracking ref and every origin/<branch> ancestry check would read as
      // no_upstream forever. One added refspec scopes tracking to exactly this
      // branch; on base there is nothing to add.
      if (branch !== project.baseBranch) {
        await git(dir, ['config', '--add', 'remote.origin.fetch',
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      }
      let found: 'existing' | 'new';
      if (fromBranch) {
        // Cut the branch from origin's copy of the source branch. "No such
        // ref" means the work never made it to origin — an error; checking
        // out from base instead would silently lose it.
        try {
          await git(dir, ['fetch', 'origin', `+refs/heads/${fromBranch}:refs/remotes/origin/${fromBranch}`], auth);
        } catch (e) {
          const msg = String((e as { stderr?: string }).stderr ?? e);
          if (/couldn't find remote ref|not found in upstream|no such ref/i.test(msg)) {
            throw new WorkspaceError('source_branch_gone',
              `the source branch ${fromBranch} is not on origin — its work never made it there, so there is nothing to copy`);
          }
          throw e;
        }
        await git(dir, ['checkout', '-B', branch, `refs/remotes/origin/${fromBranch}`]);
        found = 'new';
      } else {
        found = await checkoutBranch(dir, branch, auth);
      }
      const { stdout } = await git(dir, ['rev-parse', 'HEAD']);
      return { head: stdout.trim(), found, claimed };
    } catch (e) {
      if (e instanceof WorkspaceError) throw e;
      const why = classifyGitFailure(e, { hadToken: !!auth.pat });
      if (why) throw new WorkspaceError(why.code, `cannot check out ${project.owner}/${project.name}: ${why.message}`, why.retryable);
      throw e;
    }
  }

  /** A NEW checkout for the session `id`, on its own branch {prefix}/{id}:
   *  the files on disk, the row born with them — the branch and the commit
   *  it was cut from (`cut_from_sha`, what /git/status measures against).
   *  `fromBranch` cuts it from origin's copy of that branch instead of base
   *  (the duplicate route). */
  async checkout(project: ProjectRow, id: string, opts: { fromBranch?: string } = {}): Promise<WorkspaceRow> {
    const branch = `${project.branchPrefix}/${id}`;
    const { head, found, claimed } = await this.obtain(project, id, branch, opts.fromBranch);
    const [row] = await this.db.insert(workspaces)
      .values({ id, projectId: project.id, branch, cutFromSha: head, createdAt: new Date() }).returning();
    log.info({ workspace: id, project: `${project.owner}/${project.name}`, branch, found, claimed, cutFromSha: head },
      'checkout made');
    return row!;
  }

  /** The files back for a workspace whose files were removed: the same
   *  obtaining, then the branch the ROW remembers checked out from origin —
   *  the work is on it, and the checkout carries on where it stopped. The
   *  cut point stays what it was. */
  async restore(workspace: WorkspaceRow, project: ProjectRow): Promise<void> {
    const { found } = await this.obtain(project, workspace.id, workspace.branch);
    await this.db.update(workspaces).set({ onDisk: true, lastUsedAt: new Date() }).where(eq(workspaces.id, workspace.id));
    log.info({ workspace: workspace.id, branch: workspace.branch, found }, 'checkout restored');
    this.changed(workspace.id);
  }

  /** Delete the files and nothing else — the row keeps the branch, so
   *  `restore` brings them back where they stopped. Refuses while the
   *  checkout holds work that is not on origin unless `force` — the caller's
   *  decision to lose it; the automatic sweeps never force. */
  async removeFiles(workspace: WorkspaceRow, opts: { force: boolean }): Promise<void> {
    const dir = repoDir(this.paths, workspace.id);
    const state = await localState(dir, workspace.branch).catch(() => 'unknown' as const);
    if (state !== 'clean' && !opts.force) {
      log.warn({ workspace: workspace.id, state }, 'removing the files would discard work — refusing (pass force)');
      throw new WorkspaceError('unpushed_work', `session holds ${state} work; delete with force=true to discard`);
    }
    await fs.rm(sessionDir(this.paths, workspace.id), { recursive: true, force: true });
    await this.db.update(workspaces).set({ onDisk: false }).where(eq(workspaces.id, workspace.id));
    log.info({ workspace: workspace.id, state }, 'files removed');
    this.changed(workspace.id);
  }

  /** Workspaces in a project whose files exist — what stands in the way of
   *  deleting it (files and containers; a conversation holds neither). */
  async countOnDisk(projectId: string): Promise<number> {
    const [counted] = await this.db.select({ n: count() }).from(workspaces)
      .where(and(eq(workspaces.projectId, projectId), eq(workspaces.onDisk, true)));
    return counted!.n;
  }

  // ── activity ───────────────────────────────────────────────────────────────

  /** A person or an agent used the checkout: a tool call, a saved turn.
   *  Background jobs never touch, or nothing ever goes cold. */
  async touch(id: string): Promise<void> {
    await this.db.update(workspaces).set({ lastUsedAt: new Date() }).where(eq(workspaces.id, id));
    this.changed(id);
  }

  /** Among `candidates`, the ids not touched for `idleMs` — the idle set. The
   *  caller intersects it with running containers and running tasks. */
  async listIdle(candidates: string[], idleMs: number): Promise<string[]> {
    if (!candidates.length) return [];
    const cutoff = new Date(Date.now() - idleMs);
    const rows = await this.db.select({ id: workspaces.id }).from(workspaces)
      .where(and(inArray(workspaces.id, candidates), lt(workspaces.lastUsedAt, cutoff)));
    return rows.map((r) => r.id);
  }

  // ── the checkout lock ──────────────────────────────────────────────────────
  // One git sync writes a checkout at a time. A sync is a sequence of git
  // commands; git's index.lock guards one command, not the sequence. Same
  // conditional UPDATE as the session lock, on the row it guards. Callers
  // take it under a FRESH id per run, so it is never re-entered.

  /** Take the checkout for `holder`: free, or lapsed. Returns whether it
   *  was taken. */
  async acquireSyncLock(id: string, holder: string, ttlMs: number): Promise<boolean> {
    const rows = await this.db.update(workspaces)
      .set({ syncLockedBy: holder, syncLockExpiresAt: new Date(Date.now() + ttlMs) })
      .where(and(eq(workspaces.id, id),
        or(isNull(workspaces.syncLockedBy), isNull(workspaces.syncLockExpiresAt),
          lt(workspaces.syncLockExpiresAt, new Date()))))
      .returning({ id: workspaces.id });
    return rows.length > 0;
  }

  /** Slide `holder`'s expiry forward. */
  async renewSyncLock(id: string, holder: string, ttlMs: number): Promise<void> {
    await this.db.update(workspaces).set({ syncLockExpiresAt: new Date(Date.now() + ttlMs) })
      .where(and(eq(workspaces.id, id), eq(workspaces.syncLockedBy, holder)));
  }

  /** Release `holder`'s hold. Releasing what you do not hold changes nothing. */
  async releaseSyncLock(id: string, holder: string): Promise<void> {
    await this.db.update(workspaces).set({ syncLockedBy: null, syncLockExpiresAt: null })
      .where(and(eq(workspaces.id, id), eq(workspaces.syncLockedBy, holder)));
  }

  // ── git ────────────────────────────────────────────────────────────────────

  /** The branch reached origin. */
  async markPushed(id: string): Promise<void> {
    await this.db.update(workspaces).set({ lastPushAt: new Date() }).where(eq(workspaces.id, id));
    this.changed(id);
  }

  /** Where the checkout's work stands, as the git refresh measured it. A
   *  watcher's work-state dot follows the event. */
  async setWork(id: string, work: WorkState | null): Promise<void> {
    await this.db.update(workspaces).set({ work }).where(eq(workspaces.id, id));
    this.events?.publish(id, '', { event: 'session', work });
  }

  /** The workspaces the work-state refresh walks: the ones named (running
   *  containers), with the facts the walk needs. The card is the owning
   *  session's — the join reaches it for the board event's name. */
  async listForWorkRefresh(ids: string[]): Promise<WorkRefreshWorkspace[]> {
    if (!ids.length) return [];
    return this.db.select({
      id: workspaces.id, projectId: workspaces.projectId, branch: workspaces.branch, work: workspaces.work,
      card: cards.number,
    }).from(workspaces)
      .leftJoin(sessions, eq(sessions.id, workspaces.id))
      .leftJoin(cards, eq(cards.id, sessions.cardId))
      .where(inArray(workspaces.id, ids));
  }

  /** Workspaces whose `work` is stale: measured once, but no container runs
   *  now. The refresh clears these to null. */
  async listStaleWork(activeIds: string[]): Promise<WorkRefreshWorkspace[]> {
    const where = activeIds.length
      ? and(isNotNull(workspaces.work), not(inArray(workspaces.id, activeIds)))
      : isNotNull(workspaces.work);
    return this.db.select({
      id: workspaces.id, projectId: workspaces.projectId, branch: workspaces.branch, work: workspaces.work,
      card: cards.number,
    }).from(workspaces)
      .leftJoin(sessions, eq(sessions.id, workspaces.id))
      .leftJoin(cards, eq(cards.id, sessions.cardId))
      .where(where);
  }
}
