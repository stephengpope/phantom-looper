// INSTANT SYNC — the on-demand sync, fired for you. A workspace switch
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
//      (@parcel/watcher, inotify) does nothing but record WHEN the last
//      change happened.
//
// The beat knows no git. It calls the two functions and logs every result.
// A failure — git failed, a conflict left for the agent — is also REPORTED
// (`failed`, wired to the session feed), once per reason: the same refusal
// on the next beat ("a rebase is in progress") is the same news, and
// `busy` (a manual sync holds the checkout) is no news at all. One
// timer per checkout is only how the two calls are scheduled; what keeps
// any two syncs off one checkout is the CHECKOUT LOCK (folders.ts), taken
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
// says so as it happens: `watchFolder` runs inside the start, BEFORE the tool
// call that started it returns, so the first write is seen; `unwatchFolder`
// runs on removal. `reconcile` covers what those two cannot: containers
// already running when this process boots, and the switch or a timing
// changed (the settings bus says so) — never a poll.
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
  /** A sync that did not complete, in the sync's own words. */
  failed: (session: SessionRow, op: 'push' | 'pull', reason: string) => void;
}

interface Watched {
  folderId: string;
  workspace: WorkspaceRow;
  subscription: AsyncSubscription;
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

/** A workspace's three instant-sync settings, resolved. */
interface Config { on: boolean; debounceMs: number; pullMs: number }

export class InstantSync {
  private watched = new Map<string, Watched>();

  constructor(private deps: InstantSyncDeps) {}

  /** A container came up for this folder. Attach if its workspace has the
   *  switch on; a no-op if already attached. */
  async watchFolder(folderId: string, workspace: WorkspaceRow | undefined): Promise<void> {
    if (!workspace || this.watched.has(folderId)) return;
    const c = await this.configOf(workspace);
    if (c.on) await this.attach(folderId, workspace, c);
  }

  /** The folder's container is gone. */
  async unwatchFolder(folderId: string): Promise<void> {
    const w = this.watched.get(folderId);
    if (w) await this.detach(w);
  }

  /** Bring the watcher set in line with `activeFolderIds` (the running
   *  containers) and each workspace's switch and timings: attach the new,
   *  detach the gone or switched off, retime the rest. For boot and for a
   *  settings change — the two facts no container event carries. */
  async reconcile(activeFolderIds: string[]): Promise<void> {
    const rows = await this.deps.folders.listForWorkRefresh(activeFolderIds);
    const workspaces = new Map((await this.deps.workspaces.list()).map((w) => [w.id, w]));
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
      } else {
        await this.attach(row.id, workspace, c)
          .catch((e) => log.warn({ folder: row.id, err: errStr(e) }, 'could not start watching'));
      }
    }
    for (const [id, w] of this.watched) {
      if (!wanted.has(id)) await this.detach(w);
    }
  }

  async stop(): Promise<void> {
    for (const w of this.watched.values()) await this.detach(w);
  }

  private async configOf(workspace: WorkspaceRow): Promise<Config> {
    const c = await this.deps.settings.resolveMany(
      ['instant_sync', 'instant_sync_push_debounce_ms', 'instant_sync_pull_interval_ms'], { workspace });
    return { on: c.instant_sync, debounceMs: c.instant_sync_push_debounce_ms, pullMs: c.instant_sync_pull_interval_ms };
  }

  private async attach(folderId: string, workspace: WorkspaceRow, c: Config): Promise<void> {
    let w: Watched;
    const subscription = await watcher.subscribe(repoDir(this.deps.paths, folderId), (err, events) => {
      if (err) { log.warn({ folder: folderId, err: errStr(err) }, 'watcher error'); return; }
      if (events.length) w.changedAt = Date.now();
    }, { ignore: IGNORE });
    // `changedAt` far in the past: the first beat runs a push check, so work
    // left unpushed before this watcher existed (a server restart) goes now.
    w = { folderId, workspace, subscription, debounceMs: c.debounceMs, pullMs: c.pullMs,
      changedAt: 0, lastFailure: { push: null, pull: null }, stopped: false };
    this.watched.set(folderId, w);
    log.info({ folder: folderId, workspace: workspace.id, debounceMs: c.debounceMs, pullMs: c.pullMs }, 'instant sync on');
    void this.beat(w);
  }

  private async detach(w: Watched): Promise<void> {
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
      this.settle(w, session, 'pull', pulled);
      const since = w.changedAt;
      if (since !== null && Date.now() - since >= w.debounceMs) {
        const pushed = await this.deps.autoPush(session, w.workspace);
        this.settle(w, session, 'push', pushed);
        // The change is done with — unless the checkout was held (a manual
        // sync): then it is still pending for the next beat. A change made
        // DURING the push moved `changedAt`, and is left to settle on its own.
        if (pushed.result !== 'busy' && w.changedAt === since) w.changedAt = null;
      }
    } catch (e) {
      log.warn({ folder: w.folderId, err: errStr(e) }, 'instant sync beat threw');
    } finally {
      if (!w.stopped) w.timer = setTimeout(() => void this.beat(w), w.pullMs);
    }
  }

  /** One sync's result: logged whatever it is; a failure reported once. */
  private settle(w: Watched, session: SessionRow, op: 'push' | 'pull',
    r: AutoPushResult | AutoPullResult): void {
    const at = { folder: w.folderId, op, result: r.result };
    if (r.result === 'error' || r.result === 'blocked') {
      const reason = r.reason ?? r.result;
      // Every failure is logged; only a NEW one is reported to a person.
      if (w.lastFailure[op] === reason) { log.debug({ ...at, reason }, 'instant sync still failing'); return; }
      w.lastFailure[op] = reason;
      log.warn({ ...at, reason }, 'instant sync failed');
      this.deps.failed(session, op, reason);
      return;
    }
    if (r.result === 'busy') { log.debug(at, 'instant sync: checkout held, next beat'); return; }
    w.lastFailure[op] = null;
    if (r.result === 'pushed' || r.result === 'merged') log.info(at, 'instant sync done');
    else log.debug(at, 'instant sync: nothing to do');
  }
}
