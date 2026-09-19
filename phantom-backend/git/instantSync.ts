// INSTANT SYNC — the on-demand sync, fired for you. A workspace switch
// (`instant_sync`) that keeps every running session's checkout in step with
// the base branch on its own:
//
//   push — a file watcher on the checkout (@parcel/watcher, inotify) arms a
//          debounce on every change; when the files have been quiet for
//          `instant_sync_push_debounce_ms`, auto-push runs.
//   pull — every `instant_sync_pull_interval_ms`, a plain `git fetch` of base
//          (never the GitHub API, so it costs no rate limit); when base moved,
//          auto-pull runs.
//
// It is NOT a second sync. Both directions are the SAME `autoPush` / `autoPull`
// the cli, Telegram and the card archive call — same backup, squash, commit
// message, rebase, verify and push. Two things differ, both set by the wiring
// in index.ts and both because instant means NOW, turn or no turn:
//
//   - it never takes the session (`hold: false`), so a 30-minute turn never
//     holds a push back;
//   - it never runs the conflict fixer (no `resolve`) — a fixer is a turn in
//     the session, and the session may be mid-turn. A conflict is left
//     stopped, markers in the files, and the agent is told at its next turn.
//
// This file only decides WHEN to call them, and it never touches git except
// to read: `hasWorkToLand` and `fetchBase` are asked first, so a checkout
// with nothing to do costs no commit and no model call.
//
// WHICH checkouts: the folders with a running container, in a workspace with
// the switch on. Files only change through a container (an agent's tool
// call) or through the sync itself, so a stopped container has nothing to
// watch — and every reap frees its watcher. Reconciled every ten seconds
// from the work-state loop in index.ts: a settings change, a container
// starting or stopping, all take effect on the next pass with no events to
// wire.
//
// ONE OPERATION AT A TIME PER FOLDER. Our push and our pull are serialized
// in-process (`running`). A MANUAL sync on the same session (a person's
// /auto-push, a card archive) holds the session under GIT_CLIENT_ID; we read
// that hold and step aside for the beat — a read, never a lock.
//
// A CONFLICT IS LEFT FOR THE AGENT. The sync leaves the rebase stopped,
// markers in the files, and the agent is told (index.ts queues the note
// once). While that rebase is in progress nothing here touches the checkout
// — the agent's edits fire the watcher, and the push simply finds the
// rebase and waits. Once the agent continues it, the next change pushes.
import watcher, { type AsyncSubscription } from '@parcel/watcher';
import type { SessionRow, WorkspaceRow } from '../db/schema.js';
import { isHeld, type Sessions } from '../sessions.js';
import type { Folders } from '../folders.js';
import type { Workspaces } from '../workspaces.js';
import type { Settings } from '../settings.js';
import { repoDir, type Paths } from '../pool/paths.js';
import { resolveAuth } from '../pool/pool.js';
import { fetchBase, hasWorkToLand, rebaseInProgress, GIT_CLIENT_ID } from './git.js';
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
  pushTimer?: NodeJS.Timeout;
  pullTimer?: NodeJS.Timeout;
  /** A push or a pull is in flight on this folder. */
  running: boolean;
  stopped: boolean;
}

type Outcome = AutoPushResult['result'] | AutoPullResult['result'];

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
      if (events.length) this.schedulePush(w);
    }, { ignore: IGNORE });
    w = { folderId, dir, workspace, subscription, debounceMs, pullMs, running: false, stopped: false };
    this.watched.set(folderId, w);
    log.info({ folder: folderId, workspace: workspace.id, debounceMs, pullMs }, 'instant sync on');
    this.schedulePull(w, w.pullMs);
  }

  private async unwatch(w: Watched): Promise<void> {
    w.stopped = true;
    clearTimeout(w.pushTimer);
    clearTimeout(w.pullTimer);
    this.watched.delete(w.folderId);
    await w.subscription.unsubscribe()
      .catch((e) => log.warn({ folder: w.folderId, err: errStr(e) }, 'unsubscribe failed'));
    log.info({ folder: w.folderId }, 'instant sync off');
  }

  // ── push ───────────────────────────────────────────────────────────────────

  /** Trailing debounce: every change restarts the clock, the push fires
   *  after `debounceMs` of quiet. */
  private schedulePush(w: Watched): void {
    if (w.stopped) return;
    clearTimeout(w.pushTimer);
    w.pushTimer = setTimeout(() => void this.push(w), w.debounceMs);
  }

  private async push(w: Watched): Promise<void> {
    if (w.stopped) return;
    // A pull is on this folder: the change is not lost, the clock restarts.
    if (w.running) { this.schedulePush(w); return; }
    await this.run(w, 'push', async (session) => {
      if (!(await hasWorkToLand(w.dir, w.workspace.baseBranch))) return 'nothing';
      return this.deps.autoPush(session, w.workspace);
    });
  }

  // ── pull ───────────────────────────────────────────────────────────────────

  /** A timeout chain, not an interval: a pull that outlasts the interval is
   *  followed, never overlapped. */
  private schedulePull(w: Watched, ms: number): void {
    if (w.stopped) return;
    clearTimeout(w.pullTimer);
    w.pullTimer = setTimeout(() => void this.pull(w), ms);
  }

  private async pull(w: Watched): Promise<void> {
    if (w.stopped) return;
    try {
      if (w.running) return;
      await this.run(w, 'pull', async (session) => {
        const base = w.workspace.baseBranch;
        const arrived = await fetchBase(w.dir, base, await resolveAuth(this.deps.settings, w.workspace));
        if (!arrived.length) return 'nothing';
        return this.deps.autoPull(session, w.workspace);
      });
    } finally {
      this.schedulePull(w, w.pullMs);
    }
  }

  // ── one at a time, and the result said out loud ────────────────────────────

  private async run(
    w: Watched, op: 'push' | 'pull',
    fn: (session: SessionRow) => Promise<Outcome | AutoPushResult | AutoPullResult>,
  ): Promise<void> {
    w.running = true;
    try {
      const session = await this.deps.sessions.get(w.folderId);
      if (!session) return;
      // A manual sync holds the session — one repo, one sync at a time.
      if (isHeld(session) && session.lockedBy === GIT_CLIENT_ID) return;
      // A conflict left stopped for the agent: its checkout, not ours, until
      // the agent continues the rebase.
      if (await rebaseInProgress(w.dir)) return;
      const r = await fn(session);
      const outcome = typeof r === 'string' ? r : r.result;
      const reason = typeof r === 'string' ? undefined : r.reason;
      if (outcome === 'pushed' || outcome === 'merged') {
        log.info({ folder: w.folderId, op }, `instant ${op} done`);
      } else if (outcome === 'blocked') {
        log.warn({ folder: w.folderId, op, reason }, `instant ${op} blocked — conflict left to the agent`);
      } else if (outcome === 'error') {
        log.warn({ folder: w.folderId, op, reason }, `instant ${op} error`);
      }
    } catch (e) {
      log.warn({ folder: w.folderId, op, err: errStr(e) }, `instant ${op} threw`);
    } finally {
      w.running = false;
    }
  }
}
