// INSTANT SYNC — the on-demand sync, fired for you. A workspace switch
// (`instant_sync`) that keeps every running session's checkout in step with
// the base branch on its own.
//
// ONE BEAT PER CHECKOUT, every `instant_sync_pull_interval_ms`, doing two
// things in order:
//
//   1. auto-pull — its first step is a plain `git fetch` of base (never the
//      GitHub API, so no rate limit); nothing new and it stops right there.
//   2. auto-push — only when a file changed and the files have then been
//      quiet for `instant_sync_push_debounce_ms`. The watcher on the checkout
//      (@parcel/watcher, inotify) does nothing but record WHEN the last
//      change happened.
//
// Two operations that never overlap because there is only one timer: step 2
// waits for step 1, the next beat waits for step 2. No flag, no second lock —
// the session lock in the database is the only lock in this system.
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
//     (index.ts queues the note once). While that rebase is in progress the
//     sync refuses to touch the checkout; once the agent continues it, the
//     next change pushes.
//
// WHICH checkouts: the folders with a running container, in a workspace with
// the switch on. Files only change through a container (an agent's tool
// call) or through the sync itself, so a stopped container has nothing to
// watch — and every reap frees its watcher. Reconciled every ten seconds
// from the work-state loop in index.ts: a settings change, a container
// starting or stopping, all take effect on the next pass with no events to
// wire. The watcher arrives up to ten seconds after the container, so the
// first beat runs a push check regardless — a file written in that window
// was never seen.
import watcher, { type AsyncSubscription } from '@parcel/watcher';
import type { SessionRow, WorkspaceRow } from '../db/schema.js';
import type { Sessions } from '../sessions.js';
import type { Folders } from '../folders.js';
import type { Workspaces } from '../workspaces.js';
import type { Settings } from '../settings.js';
import { repoDir, type Paths } from '../pool/paths.js';
import type { AutoPushResult } from './autoPush.js';
import type { AutoPullResult } from './autoPull.js';
import { logger, errStr } from '../log.js';

const log = logger('instant-sync');

/** Git's own writes are not watched — every sync would trigger itself. */
const IGNORE = ['.git'];

export interface InstantSyncDeps {
  sessions: Sessions;
  folders: Folders;
  workspaces: Workspaces;
  settings: Settings;
  paths: Paths;
  /** Auto-push / auto-pull as index.ts wires them for instant sync: no
   *  hold, no fixer, notes to the backdoor queue. */
  autoPush: (session: SessionRow, workspace: WorkspaceRow) => Promise<AutoPushResult>;
  autoPull: (session: SessionRow, workspace: WorkspaceRow) => Promise<AutoPullResult>;
}

interface Watched {
  folderId: string;
  dir: string;
  workspace: WorkspaceRow;
  subscription: AsyncSubscription;
  debounceMs: number;
  pullMs: number;
  /** When a file last changed; null once that change has been pushed. */
  changedAt: number | null;
  timer?: NodeJS.Timeout;
  stopped: boolean;
}

/** A workspace's three instant-sync settings, resolved. */
interface Config { on: boolean; debounceMs: number; pullMs: number }

export class InstantSync {
  private watched = new Map<string, Watched>();

  constructor(private deps: InstantSyncDeps) {}

  /** Bring the watcher set in line with what should be watched: the folders
   *  in `activeFolderIds` (running containers) whose workspace has instant
   *  sync on. Subscribes the new, unsubscribes the gone, re-reads the timing
   *  of the rest. Called on a beat; never throws — one folder failing to
   *  subscribe (inotify limits, a vanished directory) is logged and retried
   *  next pass. */
  async reconcile(activeFolderIds: string[]): Promise<void> {
    const rows = await this.deps.folders.listForWorkRefresh(activeFolderIds);
    const workspaces = new Map((await this.deps.workspaces.list()).map((w) => [w.id, w]));
    // The switch and the two timings, once per workspace that has a running
    // container — read every pass, so a change applies without a restart.
    const configs = new Map<string, Config>();
    for (const id of new Set(rows.map((r) => r.workspaceId))) {
      const workspace = workspaces.get(id);
      if (workspace) configs.set(id, await this.configOf(workspace));
    }

    const wanted = new Set<string>();
    for (const row of rows) {
      const workspace = workspaces.get(row.workspaceId);
      const c = configs.get(row.workspaceId);
      if (!workspace || !c?.on) continue;
      wanted.add(row.id);
      const current = this.watched.get(row.id);
      if (current) {
        current.workspace = workspace;
        current.debounceMs = c.debounceMs;
        current.pullMs = c.pullMs;
        continue;
      }
      await this.watch(row.id, workspace, c.debounceMs, c.pullMs)
        .catch((e) => log.warn({ folder: row.id, err: errStr(e) }, 'could not start watching — will retry next pass'));
    }
    for (const [id, w] of this.watched) {
      if (!wanted.has(id)) await this.unwatch(w);
    }
  }

  async stop(): Promise<void> {
    for (const w of this.watched.values()) await this.unwatch(w);
  }

  private async configOf(workspace: WorkspaceRow): Promise<Config> {
    const c = await this.deps.settings.resolveMany(
      ['instant_sync', 'instant_sync_push_debounce_ms', 'instant_sync_pull_interval_ms'], { workspace });
    return { on: c.instant_sync, debounceMs: c.instant_sync_push_debounce_ms, pullMs: c.instant_sync_pull_interval_ms };
  }

  private async watch(folderId: string, workspace: WorkspaceRow, debounceMs: number, pullMs: number): Promise<void> {
    const dir = repoDir(this.deps.paths, folderId);
    let w: Watched;
    const subscription = await watcher.subscribe(dir, (err, events) => {
      if (err) { log.warn({ folder: folderId, err: errStr(err) }, 'watcher error'); return; }
      if (events.length) w.changedAt = Date.now();
    }, { ignore: IGNORE });
    // `changedAt` set as if the debounce has already passed: the first beat
    // runs a push check, covering anything written before the watcher was up.
    w = { folderId, dir, workspace, subscription, debounceMs, pullMs,
      changedAt: Date.now() - debounceMs, stopped: false };
    this.watched.set(folderId, w);
    log.info({ folder: folderId, workspace: workspace.id, debounceMs, pullMs }, 'instant sync on');
    void this.beat(w);
  }

  private async unwatch(w: Watched): Promise<void> {
    w.stopped = true;
    clearTimeout(w.timer);
    this.watched.delete(w.folderId);
    await w.subscription.unsubscribe()
      .catch((e) => log.warn({ folder: w.folderId, err: errStr(e) }, 'unsubscribe failed'));
    log.info({ folder: w.folderId }, 'instant sync off');
  }

  /** The beat: pull, then push if the files have settled. A timeout chain,
   *  not an interval — a beat that outlasts the interval is followed, never
   *  overlapped. */
  private async beat(w: Watched): Promise<void> {
    if (w.stopped) return;
    try {
      const session = await this.deps.sessions.get(w.folderId);
      if (!session) return;
      const pulled = await this.deps.autoPull(session, w.workspace);
      this.report(w, 'pull', pulled.result, pulled.reason);
      if (w.changedAt !== null && Date.now() - w.changedAt >= w.debounceMs) {
        // Cleared BEFORE the push: a change made while it runs is a new
        // change, and gets its own push once it settles.
        w.changedAt = null;
        const pushed = await this.deps.autoPush(session, w.workspace);
        this.report(w, 'push', pushed.result, pushed.reason);
      }
    } catch (e) {
      log.warn({ folder: w.folderId, err: errStr(e) }, 'instant sync beat threw');
    } finally {
      if (!w.stopped) w.timer = setTimeout(() => void this.beat(w), w.pullMs);
    }
  }

  private report(w: Watched, op: 'push' | 'pull', outcome: string, reason?: string): void {
    if (outcome === 'pushed' || outcome === 'merged') log.info({ folder: w.folderId, op }, `instant ${op} done`);
    else if (outcome === 'blocked') log.warn({ folder: w.folderId, op, reason }, `instant ${op} blocked — conflict left to the agent`);
    else if (outcome === 'error') log.warn({ folder: w.folderId, op, reason }, `instant ${op} error`);
  }
}
