// INSTANT SYNC — the on-demand sync, fired for you. A project switch
// (`instant_sync`) that keeps every live checkout in step with the base
// branch on its own.
//
// ONE BEAT PER CHECKOUT, every `instant_sync_pull_interval_ms`, doing two
// things in order:
//
//   1. auto-pull — its first step is a plain `git fetch` of base (never the
//      GitHub API, so no rate limit); nothing new and it stops right there.
//   2. auto-push — only when a file changed and the files have then been
//      quiet for `instant_sync_push_debounce_ms`. The watcher on the checkout
//      (WorkspaceWatcher — @parcel/watcher in its own child process) does
//      nothing but record WHEN the last change happened.
//
// The beat knows no git. It calls the two functions and logs every result.
// A failure — git failed, a conflict left for the agent — is also REPORTED
// (`failed`, wired to the session feed), once per reason: the same refusal
// on the next beat ("a rebase is in progress") is the same news, and
// `busy` (a manual sync holds the checkout) is no news at all. One
// timer per checkout is only how the two calls are scheduled; what keeps
// any two syncs off one checkout is the CHECKOUT LOCK (workspaces.ts), taken
// inside the sync itself by every caller.
//
// It is NOT a second sync. Both are the SAME `autoPush` / `autoPull` the cli,
// Telegram and the card archive call — same backup, squash, commit message,
// rebase, verify and push, and the same "anything to do?" check first, so an
// idle beat costs no commit and no model call. Two things differ, both set by
// the wiring in index.ts and both because instant means NOW, turn or no turn:
//
//   - it never takes the session (`hold: false`), so a 30-minute turn never
//     holds a push back;
//   - it never runs the conflict fixer (no `resolve`) — a fixer is a turn in
//     the session, and the session may be mid-turn. A conflict is left
//     stopped, markers in the files, and the agent is told at its next turn
//     (index.ts queues the note once). No sync touches the checkout until the
//     agent continues the rebase; its edits then push like any other.
//
// A LIVE CHECKOUT IS A RUNNING CONTAINER. Files only change through the
// container (an agent's tool call) or through the sync itself. The container
// starts on the first tool call and is removed when idle, and ContainerManager
// says so as it happens: `watchWorkspace` runs inside the start, BEFORE the tool
// call that started it returns, so the first write is seen; `unwatchWorkspace`
// runs on removal. `reconcile` covers what those two cannot: containers
// already running when this process boots, and the switch or a timing
// changed (the settings bus says so) — never a poll.
import type { SessionRow, ProjectRow } from '../db/schema.js';
import type { Sessions } from '../sessions.js';
import type { Workspaces } from '../workspaces.js';
import type { Projects } from '../projects.js';
import type { Settings } from '../settings.js';
import { repoDir, type Paths } from '../pool/paths.js';
import type { AutoPushResult } from './autoPush.js';
import type { AutoPullResult } from './autoPull.js';
import type { WorkspaceWatcher } from './workspaceWatcher.js';
import { logger, errStr } from '../log.js';

const log = logger('instant-sync');

export interface InstantSyncDeps {
  sessions: Sessions;
  workspaces: Workspaces;
  projects: Projects;
  settings: Settings;
  paths: Paths;
  watcher: WorkspaceWatcher;
  /** Auto-push / auto-pull as index.ts wires them for instant sync: no
   *  hold, no fixer, notes to the backdoor queue. */
  autoPush: (session: SessionRow, project: ProjectRow) => Promise<AutoPushResult>;
  autoPull: (session: SessionRow, project: ProjectRow) => Promise<AutoPullResult>;
  /** A sync that did not complete, in the sync's own words. */
  failed: (session: SessionRow, op: 'push' | 'pull', reason: string) => void;
}

interface Watched {
  workspaceId: string;
  project: ProjectRow;
  debounceMs: number;
  pullMs: number;
  /** When a file last changed; null once that change has been pushed. */
  changedAt: number | null;
  /** The failure last reported, per direction — so a beat that hits the
   *  same wall says nothing new. Cleared by a sync that ran and did not
   *  fail; `busy` (it did not run) leaves it alone. */
  lastFailure: { push: string | null; pull: string | null };
  timer?: NodeJS.Timeout;
  stopped: boolean;
}

/** A project's three instant-sync settings, resolved. */
interface Config { on: boolean; debounceMs: number; pullMs: number }

export class InstantSync {
  private watched = new Map<string, Watched>();

  constructor(private deps: InstantSyncDeps) {}

  /** A container came up for this workspace. Attach if its project has the
   *  switch on; a no-op if already attached. */
  async watchWorkspace(workspaceId: string, project: ProjectRow | undefined): Promise<void> {
    if (!project || this.watched.has(workspaceId)) return;
    const c = await this.configOf(project);
    if (c.on) await this.attach(workspaceId, project, c);
  }

  /** The workspace's container is gone. */
  async unwatchWorkspace(workspaceId: string): Promise<void> {
    const watcher = this.watched.get(workspaceId);
    if (watcher) await this.detach(watcher);
  }

  /** Bring the watcher set in line with `activeWorkspaceIds` (the running
   *  containers) and each project's switch and timings: attach the new,
   *  detach the gone or switched off, retime the rest. For boot and for a
   *  settings change — the two facts no container event carries. */
  async reconcile(activeWorkspaceIds: string[]): Promise<void> {
    const rows = await this.deps.workspaces.listForWorkRefresh(activeWorkspaceIds);
    const projects = new Map((await this.deps.projects.list()).map((project) => [project.id, project]));
    const configs = new Map<string, Config>();
    for (const id of new Set(rows.map((r) => r.projectId))) {
      const project = projects.get(id);
      if (project) configs.set(id, await this.configOf(project));
    }
    const wanted = new Set<string>();
    for (const row of rows) {
      const project = projects.get(row.projectId);
      const c = configs.get(row.projectId);
      if (!project || !c?.on) continue;
      wanted.add(row.id);
      const current = this.watched.get(row.id);
      if (current) {
        current.project = project;
        current.debounceMs = c.debounceMs;
        current.pullMs = c.pullMs;
      } else {
        await this.attach(row.id, project, c)
          .catch((e) => log.warn({ workspace: row.id, err: errStr(e) }, 'could not start watching'));
      }
    }
    for (const [id, project] of this.watched) {
      if (!wanted.has(id)) await this.detach(project);
    }
  }

  async stop(): Promise<void> {
    for (const project of this.watched.values()) await this.detach(project);
    this.deps.watcher.stop();
  }

  private async configOf(project: ProjectRow): Promise<Config> {
    const c = await this.deps.settings.resolveMany(
      ['instant_sync', 'instant_sync_push_debounce_ms', 'instant_sync_pull_interval_ms'], { project });
    return { on: c.instant_sync, debounceMs: c.instant_sync_push_debounce_ms, pullMs: c.instant_sync_pull_interval_ms };
  }

  private async attach(workspaceId: string, project: ProjectRow, c: Config): Promise<void> {
    // `changedAt` far in the past: the first beat runs a push check, so work
    // left unpushed before this watcher existed (a server restart) goes now.
    const watched: Watched = { workspaceId, project, debounceMs: c.debounceMs, pullMs: c.pullMs,
      changedAt: 0, lastFailure: { push: null, pull: null }, stopped: false };
    this.deps.watcher.watch(workspaceId, repoDir(this.deps.paths, workspaceId), () => { watched.changedAt = Date.now(); });
    this.watched.set(workspaceId, watched);
    log.info({ workspace: workspaceId, project: project.id, debounceMs: c.debounceMs, pullMs: c.pullMs }, 'instant sync on');
    void this.beat(watched);
  }

  private async detach(watched: Watched): Promise<void> {
    watched.stopped = true;
    clearTimeout(watched.timer);
    this.watched.delete(watched.workspaceId);
    this.deps.watcher.unwatch(watched.workspaceId);
    log.info({ workspace: watched.workspaceId }, 'instant sync off');
  }

  /** The beat: pull, then push if the files have settled. A timeout chain,
   *  not an interval — a beat that outlasts the interval is followed, never
   *  overlapped. */
  private async beat(watched: Watched): Promise<void> {
    if (watched.stopped) return;
    try {
      const session = await this.deps.sessions.get(watched.workspaceId);
      if (!session) return;
      const pulled = await this.deps.autoPull(session, watched.project);
      this.settle(watched, session, 'pull', pulled);
      const since = watched.changedAt;
      if (since !== null && Date.now() - since >= watched.debounceMs) {
        const pushed = await this.deps.autoPush(session, watched.project);
        this.settle(watched, session, 'push', pushed);
        // The change is done with when it pushed or there was nothing to push.
        // `busy` means someone else is handling it — the change is still
        // pending. `error` or `blocked` means the push FAILED — the change
        // must stay pending so the next beat retries; clearing it here
        // stranded work on the branch forever (nothing re-sets changedAt
        // without a new file-watcher event). A change made DURING the push
        // moved `changedAt`, and is left to settle on its own.
        if ((pushed.result === 'pushed' || pushed.result === 'nothing') && watched.changedAt === since) watched.changedAt = null;
      }
    } catch (e) {
      log.warn({ workspace: watched.workspaceId, err: errStr(e) }, 'instant sync beat threw');
    } finally {
      if (!watched.stopped) watched.timer = setTimeout(() => void this.beat(watched), watched.pullMs);
    }
  }

  /** One sync's result: logged whatever it is; a failure reported once. */
  private settle(watched: Watched, session: SessionRow, op: 'push' | 'pull',
    r: AutoPushResult | AutoPullResult): void {
    const at = { workspace: watched.workspaceId, op, result: r.result };
    if (r.result === 'error' || r.result === 'blocked') {
      const reason = r.reason ?? r.result;
      // Every failure is logged; only a NEW one is reported to a person.
      if (watched.lastFailure[op] === reason) { log.debug({ ...at, reason }, 'instant sync still failing'); return; }
      watched.lastFailure[op] = reason;
      log.warn({ ...at, reason }, 'instant sync failed');
      this.deps.failed(session, op, reason);
      return;
    }
    if (r.result === 'busy') { log.debug(at, 'instant sync: checkout held, next beat'); return; }
    watched.lastFailure[op] = null;
    if (r.result === 'pushed' || r.result === 'merged') log.info(at, 'instant sync done');
    else log.debug(at, 'instant sync: nothing to do');
  }
}
