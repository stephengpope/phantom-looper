// The backend's git, assembled: the manual operations (GitSync), auto-push
// and auto-pull with the card blocked on an unresolved conflict, instant
// sync on the running containers, the two disk sweeps, and the one board
// policy — a DONE card archived auto-pushes its session's work. Every piece
// was wired by hand in the app's index.ts before; this object owns the
// wiring, and the app supplies only what is its own (config.git): the
// conflict fixer (its coding agent), the commit-message writer (its model),
// and the words the agent reads after a sync (its prompts).
//
// THE CONFLICT RESOLVER is the session's own coding agent, not a separate
// fixer — the app's, because the agent is. Why the agent that wrote the code:
// it is the author. It already carries the card, the work and its own
// reasoning, so it needs no briefing a stranger would have to be given and
// could only be given badly; the resolution lands in the SESSION'S transcript
// rather than a side file nothing reads; and the agent learns its files moved
// under it, which a side process could never tell it. It holds no
// credentials — resolving a conflict is editing files; the fetch before and
// the push after stay in this process.
import type { ProjectRow, SessionRow } from '../storage/schema.js';
import type { Sessions } from '../storage/Sessions.js';
import type { Workspaces } from '../storage/Workspaces.js';
import type { Cards } from '../storage/Cards.js';
import type { Projects } from '../storage/Projects.js';
import type { Settings } from '../storage/Settings.js';
import type { Paths } from '../lib/paths.js';
import type { SessionEvents } from '../agents/SessionEvents.js';
import type { BoardEvents } from '../agents/BoardEvents.js';
import type { SettingsEvents } from '../agents/SettingsEvents.js';
import type { UserMessageQueue } from '../agents/UserMessageQueue.js';
import type { SessionContainers } from '../runtime/SessionContainers.js';
import type { WorkspaceWatcher } from './WorkspaceWatcher.js';
import { GitSync } from './GitSync.js';
import { InstantSync } from './InstantSync.js';
import { autoPush, type AutoPushEvent, type AutoPushResult } from './autoPush.js';
import { autoPull, type AutoPullEvent, type AutoPullResult } from './autoPull.js';
import { GIT_CLIENT_ID } from './Git.js';
import type { SyncDeps, SyncEvent, SyncResult, SyncOptions } from './sync.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('git');

/** What the app brings to the backend's git — everything that is the
 *  app's agent or the app's words. Each is optional: without a fixer a
 *  conflict blocks; without a writer a sync that needs a commit fails with
 *  that reason; without words the agent hears nothing after a sync. */
export interface GitHooks {
  /** Hand a stopped rebase to the session's own agent, as a turn in its own
   *  transcript: resolve, stage, continue. True when the rebase went on. The
   *  sync holds the session under GIT_CLIENT_ID while this runs, so the
   *  agent re-takes that hold rather than finding it. */
  resolveConflict?: SyncDeps['resolve'];
  /** The commit's subject line from the staged diff — a model call. */
  writeCommitMessage?: SyncDeps['writeCommitMessage'];
  /** What the session's agent reads on its next turn after a sync: what
   *  landed (`ok`), or what conflicted (`blocked`, with files). Null = say
   *  nothing. Queued as a user message the backend holds for the session. */
  syncNote?: (project: ProjectRow, result: SyncResult, opts: SyncOptions) => string | null;
}

export interface GitServiceDeps {
  sessions: Sessions; workspaces: Workspaces; cards: Cards; projects: Projects; settings: Settings; paths: Paths;
  sessionEvents: SessionEvents; boardEvents: BoardEvents; settingsEvents: SettingsEvents;
  userMessageQueue: UserMessageQueue; sessionContainers: SessionContainers; workspaceWatcher: WorkspaceWatcher;
}

export type AutoPushFn = (session: SessionRow, project: ProjectRow,
  onEvent?: (e: AutoPushEvent) => void | Promise<void>, by?: string) => Promise<AutoPushResult>;
export type AutoPullFn = (session: SessionRow, project: ProjectRow,
  onEvent?: (e: AutoPullEvent) => void | Promise<void>, by?: string) => Promise<AutoPullResult>;

export class GitService {
  /** The manual operations: push, pull, status, backup. */
  readonly sync: GitSync;
  readonly instantSync: InstantSync;

  constructor(private readonly deps: GitServiceDeps, private readonly hooks: GitHooks) {
    const { sessions, workspaces, cards, settings, paths, sessionEvents, projects } = deps;
    // Every sync step also lands on the session's live feed, so a window
    // WATCHING the session sees the sync whoever kicked it off — a card
    // archive fires one detached, with no stream of its own. Published under
    // the caller's own client id (`by`) when the call came from a route: the
    // feed's echo rule then skips the one window that already draws the
    // stream it asked for.
    // The manual /git/pull has no stream of its own — the feed is how anyone
    // sees it run, so its steps publish under the git client (no caller to echo).
    this.sync = new GitSync({ sessions, workspaces, cards, settings, paths,
      resolve: hooks.resolveConflict, writeCommitMessage: hooks.writeCommitMessage },
    (sessionId, e) => this.publishSync(sessionId, 'pull')(e));

    // Instant sync runs the same sync, turn or no turn: it never takes the
    // session (`hold: false`) and never runs the fixer (no `resolve`) — a
    // conflict is left stopped and reported. Its notes cannot go through
    // recordSummary (that needs the session); they ride the user message
    // queue, in front of the agent's next turn wherever that turn runs. A
    // note already waiting is not queued again.
    //
    // It publishes NO steps to the feed: nobody asked for it, so its progress
    // is noise on every open window. What does reach the feed is a failure
    // (`sync-failed`) — the one thing a person needs to hear from it.
    const instantDeps = { sessions, workspaces, cards, settings, paths,
      writeCommitMessage: hooks.writeCommitMessage, recordSummary: this.noteForNextTurn };
    this.instantSync = new InstantSync({
      sessions, workspaces, projects, settings, paths, watcher: deps.workspaceWatcher,
      autoPush: (session, project) => autoPush(instantDeps, session, project, { hold: false }),
      autoPull: (session, project) => autoPull(instantDeps, session, project, { hold: false }),
      failed: (session, op, reason) =>
        sessionEvents.publish(session.id, GIT_CLIENT_ID, { event: 'sync-failed', op, reason }),
    });
  }

  private publishSync(sessionId: string, op: 'push' | 'pull', by?: string) {
    return (e: SyncEvent) => this.deps.sessionEvents.publish(sessionId, by || GIT_CLIENT_ID,
      { event: 'sync', op, step: e.step, label: e.label, detail: e.detail });
  }

  /** After a successful held sync, the agent hears what happened on its
   *  next turn: a user message the backend holds for the session, written
   *  into the record at turn-start — the same door instant sync's notes take. */
  private readonly recordSummary: SyncDeps['recordSummary'] = async (session, project, result, opts) => {
    if (result.outcome !== 'ok') return;
    const note = this.hooks.syncNote?.(project, result, opts);
    if (note) this.deps.userMessageQueue.push(session.id, note);
  };

  /** Instant sync's note: what landed, or what conflicted — unless the same
   *  note is already waiting. */
  private readonly noteForNextTurn: SyncDeps['recordSummary'] = async (session, project, result, opts) => {
    if (result.outcome !== 'ok' && !(result.outcome === 'blocked' && result.files?.length)) return;
    const note = this.hooks.syncNote?.(project, result, opts);
    if (note && !this.deps.userMessageQueue.has(session.id, note)) this.deps.userMessageQueue.push(session.id, note);
  };

  /** When a sync comes back blocked and the session is running a card, the
   *  card is blocked deterministically — the system decides, not the agent.
   *  The write is Cards' own; the board bus carries it to the UI and the looper. */
  private async blockCardOnConflict(session: SessionRow, project: ProjectRow, reason: string): Promise<void> {
    const card = await this.deps.cards.ofSession(session.id).catch(() => undefined);
    if (!card) return;
    await this.deps.cards.update(project, card.number, { status: 'blocked', blocked_reason: reason, resolution: null }, undefined, GIT_CLIENT_ID)
      .catch((e) => log.warn({ session: session.id, err: errStr(e) }, 'could not block card after unresolved conflict'));
  }

  private get syncDeps(): Omit<SyncDeps, 'onEvent'> {
    const { sessions, workspaces, cards, settings, paths } = this.deps;
    return { sessions, workspaces, cards, settings, paths,
      resolve: this.hooks.resolveConflict, recordSummary: this.recordSummary, writeCommitMessage: this.hooks.writeCommitMessage };
  }

  /** The whole path to base: take the session, commit, replay on base,
   *  verify, push, land. Every step on the session's feed. */
  readonly autoPush: AutoPushFn = async (session, project, onEvent, by) => {
    const publish = this.publishSync(session.id, 'push', by);
    const r = await autoPush({ ...this.syncDeps, onEvent: async (e) => { publish(e); await onEvent?.(e); } }, session, project);
    if (r.result === 'blocked') await this.blockCardOnConflict(session, project, r.reason ?? 'a rebase conflict could not be resolved');
    return r;
  };

  /** Auto-pull rides the same resolver and the same message model — one
   *  configuration for every git operation that commits or resolves. */
  readonly autoPull: AutoPullFn = async (session, project, onEvent, by) => {
    const publish = this.publishSync(session.id, 'pull', by);
    const r = await autoPull({ ...this.syncDeps, onEvent: async (e) => { publish(e); await onEvent?.(e); } }, session, project);
    if (r.result === 'blocked') await this.blockCardOnConflict(session, project, r.reason ?? 'a rebase conflict could not be resolved');
    return r;
  };

  /** Bring the instant-sync watcher set in line with the running
   *  containers once — never on a clock. What the container events cannot
   *  say: the switch or a timing changed (the settings bus announces every
   *  write), and containers already running when this process came up. */
  reconcileInstantSync(): Promise<void> {
    return this.deps.sessionContainers.activeWorkspaces()
      .then((active) => this.instantSync.reconcile(active))
      .catch((e) => log.error({ err: errStr(e) }, 'instant sync reconcile threw'));
  }

  /** Wire what runs on its own: instant sync follows the settings bus and
   *  the containers; archiving a DONE card auto-pushes its session's work. */
  start(): void {
    this.deps.settingsEvents.subscribe(() => { void this.reconcileInstantSync(); });
    void this.reconcileInstantSync();

    // Archiving a DONE card auto-pushes its session's work, when
    // `auto_push_on_archive` says so — a listener on the board bus, so it
    // fires for every door that archives (a route, an assistant, a tool),
    // on the false → true transition only. Archiving from any other column is
    // just archiving: the discard gesture. Detached: the write answered long
    // ago; an auto-push can run for minutes. The session lock may be held (a
    // turn mid-flight): wait it out rather than blocking the card over a
    // moment's contention. Failure surfaces on the board: the card comes back
    // un-archived, in blocked, with the reason.
    this.deps.boardEvents.subscribeAll((projectId, e) => {
      if (e.event !== 'card' || e.archivedBefore !== false) return;
      const card = e.card as { number: number; archived?: boolean; status?: string };
      if (card.archived !== true || card.status !== 'done') return;
      void (async () => {
        const project = await this.deps.projects.get(projectId);
        const session = project && await this.deps.sessions.coderOf(project.id, card.number);
        if (!project || !session || session.status !== 'active') return;
        if (await this.deps.settings.resolve('auto_push_on_archive', { projectId: project.id }) !== true) return;
        let result: AutoPushResult | { result: 'error'; reason: string } | undefined;
        for (let i = 0; i < 30; i++) {
          try { result = await this.autoPush(session, project); break; }
          catch (err) {
            if ((err as { code?: string }).code === 'busy') { await new Promise((wake) => setTimeout(wake, 10_000)); continue; }
            result = { result: 'error', reason: errStr(err) }; break;
          }
        }
        result ??= { result: 'error', reason: 'session stayed busy — auto-push never ran' };
        if (result.result === 'pushed' || result.result === 'nothing') {
          log.info({ project: project.name, card: card.number, result: result.result }, 'auto-push on archive');
          return;
        }
        log.warn({ project: project.name, card: card.number, result }, 'auto-push on archive failed — card un-archived into blocked');
        await this.deps.cards.unarchiveAsBlocked(project, card.number, `auto-push failed: ${result.reason ?? result.result}`)
          .catch((err) => log.error({ card: card.number, err: errStr(err) }, 'could not mark the card blocked after a failed auto-push'));
      })().catch((err) => log.error({ card: card.number, err: errStr(err) }, 'auto-push on archive threw'));
    });
  }

  async stop(): Promise<void> { await this.instantSync.stop(); }
}
