// Boot: the backend (PhantomBackend.create: env -> database -> migrations
// -> every service), then this app's own wiring around it — the git syncs
// and their conflict fixer (core/llm, until GitSync), the HTTP app, the
// looper, the cron scheduler, the Telegram engine, the digest, the upgrade
// check — then listen.
import { PhantomBackend, APP_VERSION as VERSION, telegramChannel, registerTools, logger, errStr } from 'phantom-backend-sdk';
import { config } from './config.js';
import { BackendClient } from 'phantom-client-sdk';
import { CodingAgent } from '../core/agents/coding.js';
import { writeTitle } from './sessionTitle.js';
import { CronEngine } from './crons/engine.js';
import { System } from 'phantom-backend-sdk';
import { appRoutes, type AppExtras } from './api/appRoutes.js';
import { gitTools } from './tools/git.js';
import { updateShutdown } from 'phantom-backend-sdk';
import { GitSync, autoPush, autoPull, InstantSync, idleBackupSweep, pressureSweep, type AutoPushEvent, type AutoPullEvent, type ConflictContext, type SyncDeps, type SyncEvent } from 'phantom-backend-sdk';
import { writeCommitMessage } from './git/commitMessage.js';
import { GIT_CLIENT_ID } from 'phantom-backend-sdk/git';
import { SessionDigest } from './notifications/digest.js';
import { toCodingAgent } from '../core/prompts/autoPush/wiring.js';
import type { ProjectRow, SessionRow } from 'phantom-backend-sdk/schema';
import { LooperEngine } from './looper/engine.js';
import { TelegramAssistantBot } from './telegram/TelegramAssistantBot.js';

const log = logger('boot');
/** The session image a fresh install pulls tracks THIS backend's release: a
 *  tagged build names the image at the same tag (both are published together
 *  by the release workflow), a dev build names :latest (scripts/setup.sh
 *  builds it locally under that tag). */
const SESSION_IMAGE_TAG = /^v\d+\.\d+\.\d+/.test(VERSION) ? VERSION : 'latest';

async function main() {
  // The backend: every service built and connected (PhantomBackend.create),
  // nothing running yet. The container hooks are closures: instant sync is
  // wired below, long before any container starts.
  let instantSync: InstantSync;
  const backend = await PhantomBackend.create(config, {
    sessionImageTag: SESSION_IMAGE_TAG,
    onContainerStarted: (workspaceId, project) => instantSync.watchWorkspace(workspaceId, project),
    onContainerRemoved: (workspaceId) => instantSync.unwatchWorkspace(workspaceId),
  });
  const { env, paths, database, settings, agentConfig, modelCatalog, projects, workspaces, cards, sessions, backgroundTasks, presets, crons,
    agentDatabases: databases, tokenLog: logTokens, sessionEvents, boardEvents: events, settingsEvents, docker, images,
    sessionContainers: containers, userMessageQueue: backdoor, telegramBotState, telegramSentMessages, telegramHandledUpdates } = backend;
  // THE CONFLICT RESOLVER — the session's own coding agent, not a separate
  // fixer. Shared by auto-push, auto-pull and the manual /git/pull.
  //
  // Why the agent that wrote the code: it is the author. It already carries the
  // card, the work and its own reasoning, so it needs no briefing a stranger
  // would have to be given and could only be given badly; the resolution lands
  // in the SESSION'S transcript rather than a side file nothing reads; and the
  // agent learns its files moved under it, which a side process could never
  // tell it. It holds no credentials — resolving a conflict is editing files;
  // the fetch before and the push after stay in this process.
  //
  // `app` is captured lazily: the hook is built before buildApp and only ever
  // runs long after boot.
  const gitClient = new BackendClient({ url: backend.loopback.url, apiKey: env.apiKey, clientId: GIT_CLIENT_ID, label: 'git sync' });
  const resolveConflict = async (
    session: SessionRow, project: ProjectRow, _dir: string, ctx: ConflictContext,
  ): Promise<boolean> => {
    // The SAME client id the sync holds the session under — a holder may
    // re-take its own hold; any other id would find the session locked by us.
    let agent: CodingAgent | undefined;
    try {
      agent = await CodingAgent.resumeSession(gitClient, {
        onError: (error) => log.warn({ session: session.id, code: error.code, err: error.message }, 'conflict turn error'),
        onNotice: (notice) => log.info({ session: session.id }, notice.text),
      }, session.id);
      // Resolving means writing files: never in plan mode.
      await sessions.setPlanMode(session.id, false);
      const result = await agent.sendMessage(toCodingAgent.resolveConflict(ctx.branch, ctx.baseBranch, ctx.files, ctx.arrived));
      return result?.outcome === 'done';
    } catch (e) {
      if ((e as { code?: string }).code === 'session_locked') log.warn({ session: session.id }, 'conflict turn could not open the session — it is busy');
      else log.error({ session: session.id, err: errStr(e) }, 'conflict turn failed');
      return false;
    } finally {
      await agent?.close().catch(() => {});
    }
  };
  // The sync's commit message rides the ASSISTANT's model — the small-fast
  // slot; writing one subject line from a diff is not work for the model doing
  // the engineering. A config that cannot build THROWS, and the sync fails
  // with that reason: there is no file-name fallback anywhere. `report` is
  // the sync's commit-step event stream, so a retry's waits are visible.
  const oneShotDeps = { agentConfig, client: gitClient };
  const commitMessage: SyncDeps['writeCommitMessage'] = (input, report) => writeCommitMessage(oneShotDeps, input, report);
  // Every sync step also lands on the session's live feed, so a window
  // WATCHING the session sees the sync whoever kicked it off — a card
  // archive fires one detached, with no stream of its own. Published under
  // the caller's own client id (`by`) when the call came from a route: the
  // feed's echo rule then skips the one window that already draws the
  // stream it asked for. `sessionEvents` is captured lazily, like `app`.
  const publishSync = (sessionId: string, op: 'push' | 'pull', by?: string) =>
    (e: SyncEvent) => sessionEvents.publish(sessionId, by || GIT_CLIENT_ID,
      { event: 'sync', op, step: e.step, label: e.label, detail: e.detail });
  // The manual /git/pull has no stream of its own — the feed is how anyone
  // sees it run, so its steps publish under the git client (no caller to echo).
  const engine = new GitSync({ sessions, workspaces, cards, settings, paths,
    resolve: resolveConflict, writeCommitMessage: commitMessage }, (sessionId, e) => publishSync(sessionId, 'pull')(e));

  // After a successful sync, the coding agent hears what happened on its next
  // turn: a user message the backend holds for the session (the queue), written
  // into the record at turn-start — the same door instant sync's notes take.
  const recordSummary: SyncDeps['recordSummary'] = async (session, project, result, opts) => {
    if (result.outcome !== 'ok') return;
    backdoor.push(session.id, toCodingAgent.syncSummary(project.baseBranch, opts.landOnBase, result.arrived ?? [], result.files ?? []));
  };

  // When a sync comes back blocked and the session is running a card, the card
  // is blocked deterministically — the system decides, not the agent. The
  // write is Cards' own; the board bus carries it to the UI and the looper.
  const blockCardOnConflict = async (session: SessionRow, project: ProjectRow, reason: string) => {
    const card = await cards.ofSession(session.id).catch(() => undefined);
    if (!card) return;
    await cards.update(project, card.number, { status: 'blocked', blocked_reason: reason, resolution: null }, undefined, GIT_CLIENT_ID)
      .catch((e) => log.warn({ session: session.id, err: errStr(e) }, 'could not block card after unresolved conflict'));
  };
  const syncDeps = { sessions, workspaces, cards, settings, paths,
    resolve: resolveConflict, recordSummary, writeCommitMessage: commitMessage };
  const autoPushFn = async (session: SessionRow, project: ProjectRow,
    onEvent?: (e: AutoPushEvent) => void | Promise<void>, by?: string) => {
    const publish = publishSync(session.id, 'push', by);
    const r = await autoPush({ ...syncDeps,
      onEvent: async (e) => { publish(e); await onEvent?.(e); } }, session, project);
    if (r.result === 'blocked') await blockCardOnConflict(session, project,
      r.reason ?? 'a rebase conflict could not be resolved');
    return r;
  };
  // Auto-pull rides the same resolver and the same message model — one
  // configuration for every git operation that commits or resolves.
  const autoPullFn = async (session: SessionRow, project: ProjectRow,
    onEvent?: (e: AutoPullEvent) => void | Promise<void>, by?: string) => {
    const publish = publishSync(session.id, 'pull', by);
    const r = await autoPull({ ...syncDeps,
      onEvent: async (e) => { publish(e); await onEvent?.(e); } }, session, project);
    if (r.result === 'blocked') await blockCardOnConflict(session, project,
      r.reason ?? 'a rebase conflict could not be resolved');
    return r;
  };

  // Instant sync (git/instantSync.ts) runs the same sync, turn or no turn:
  // it never takes the session (`hold: false`) and never runs the fixer
  // (no `resolve`) — a conflict is left stopped and reported. Its notes cannot
  // go through recordSummary above (that needs the session); they ride
  // the backdoor queue, in front of the agent's next turn wherever that
  // turn runs. A note already waiting is not queued again.
  //
  // It publishes NO steps to the feed: nobody asked for it, so its progress
  // is noise on every open window. What does reach the feed is a failure
  // (`sync-failed`) — the one thing a person needs to hear from it.
  const noteForNextTurn: SyncDeps['recordSummary'] = async (session, project, result, opts) => {
    let message: string;
    if (result.outcome === 'ok') {
      message = toCodingAgent.syncSummary(project.baseBranch, opts.landOnBase, result.arrived ?? [], result.files ?? []);
    } else if (result.outcome === 'blocked' && result.files?.length) {
      message = toCodingAgent.syncConflict(project.baseBranch, result.arrived ?? [], result.files);
    } else return;
    if (!backdoor.has(session.id, message)) backdoor.push(session.id, message);
  };
  const instantDeps = { sessions, workspaces, cards, settings, paths, writeCommitMessage: commitMessage, recordSummary: noteForNextTurn };
  instantSync = new InstantSync({
    sessions, workspaces, projects, settings, paths, watcher: backend.workspaceWatcher,
    autoPush: (session, project) => autoPush(instantDeps, session, project, { hold: false }),
    autoPull: (session, project) => autoPull(instantDeps, session, project, { hold: false }),
    failed: (session, op, reason) =>
      sessionEvents.publish(session.id, GIT_CLIENT_ID, { event: 'sync-failed', op, reason }),
  });
  // What the container events cannot say: the switch or a timing changed
  // (the settings bus announces every write), and containers already running
  // when this process came up (they outlive it). Each brings the watcher set
  // in line with the running containers once — never on a clock.
  const reconcileInstantSync = () => containers.activeWorkspaces()
    .then((active) => instantSync.reconcile(active))
    .catch((e) => log.error({ err: errStr(e) }, 'instant sync reconcile threw'));
  settingsEvents.subscribe(() => { void reconcileInstantSync(); });
  void reconcileInstantSync();

  // The backend's own loops: pool stock, idle reaping, the two disk sweeps
  // (which need the git engine, so they are handed in), work-state refresh.
  backend.startLoops({
    idleBackup: () => idleBackupSweep(projects, sessions, engine),
    pressure: () => pressureSweep(settings, projects, sessions, paths, images, containers, engine, (ids) => backend.busyWorkspaces(ids)),
  });

  const system = new System(paths, logTokens, docker ?? undefined, images, process.env.UPDATE_TRIGGER_DIR || undefined,
    () => backend.hooks.runningLoops?.() ?? 0);
  const extras: AppExtras = {
    apiKey: env.apiKey, engine, system, autoPush: autoPushFn, autoPull: autoPullFn,
    updateTriggerDir: process.env.UPDATE_TRIGGER_DIR || undefined,
  };
  backend.hooks.gitSync = { push: (session, project) => engine.push(session, project), detach: (sessionId) => engine.detach(sessionId) };
  backend.httpApi.addRoutes(appRoutes(backend, extras));
  backend.httpApi.addPublicPath('/api/telegram/webhook');
  registerTools(gitTools(extras));
  await backend.httpApi.build();
  const app = backend.httpApi.app;

  // Archiving a DONE card auto-pushes its session's work, when
  // `auto_push_on_archive` says so — a listener on the board bus, so it
  // fires for every door that archives (a route, the Assistant, a tool),
  // on the false → true transition only. Archiving from any other column is
  // just archiving: the discard gesture. Detached: the write answered long
  // ago; an auto-push can run for minutes. The session lock may be held (a
  // turn mid-flight): wait it out rather than blocking the card over a
  // moment's contention. Failure surfaces on the board: the card comes back
  // un-archived, in blocked, with the reason.
  events.subscribeAll((projectId, e) => {
    if (e.event !== 'card' || e.archivedBefore !== false) return;
    const card = e.card as { number: number; archived?: boolean; status?: string };
    if (card.archived !== true || card.status !== 'done') return;
    void (async () => {
      const project = await projects.get(projectId);
      const session = project && await sessions.coderOf(project.id, card.number);
      if (!project || !session || session.status !== 'active') return;
      if (await settings.resolve('auto_push_on_archive', { projectId: project.id }) !== true) return;
      let result: Awaited<ReturnType<typeof autoPushFn>> | undefined;
      for (let i = 0; i < 30; i++) {
        try { result = await autoPushFn(session, project); break; }
        catch (err) {
          if ((err as { code?: string }).code === 'busy') { await new Promise((r) => setTimeout(r, 10_000)); continue; }
          result = { result: 'error', reason: errStr(err) }; break;
        }
      }
      result ??= { result: 'error', reason: 'session stayed busy — auto-push never ran' };
      if (result.result === 'pushed' || result.result === 'nothing') {
        log.info({ project: project.name, card: card.number, result: result.result }, 'auto-push on archive');
        return;
      }
      log.warn({ project: project.name, card: card.number, result }, 'auto-push on archive failed — card un-archived into blocked');
      await cards.unarchiveAsBlocked(project, card.number, `auto-push failed: ${result.reason ?? result.result}`)
        .catch((err) => log.error({ card: card.number, err: errStr(err) }, 'could not mark the card blocked after a failed auto-push'));
    })().catch((err) => log.error({ card: card.number, err: errStr(err) }, 'auto-push on archive threw'));
  });


  // The looper — built after listen: its turns' TOOLS are clients of this
  // server's own surface (the same tools every client runs), so the routes
  // must be answering. Event-driven: every card write reaches it over the
  // board bus; start() is ONE recovery sweep, not a poll.
  const looper = new LooperEngine({ sessions, projects, cards, settings, logTokens, loopback: backend.loopback, events, settingsEvents, sessionEvents });
  backend.hooks.runningLoops = () => looper.runningCount();
  looper.start();

  // The cron scheduler — the same shape: a client of this app, built after
  // listen. One croner job per cron row fires at its time; registrations
  // follow the table's writes and the settings' (events, no polling).
  const cronEngine = new CronEngine({ crons, projects, settings, sessions, loopback: backend.loopback, settingsEvents });
  cronEngine.start();

  // The Telegram engine — a client of this app like the looper. The webhook
  // URL is always https + PHANTOM_BACKEND_ADDRESS (the same fact the https
  // profile runs on); with no address, telegram stays off. Reconcile at boot
  // re-registers a stale webhook and pushes the command menu.
  const telegram = new TelegramAssistantBot({
    bot: backend.telegramBot, botState: telegramBotState, settings, modelCatalog, sessions, cards, projects, presets, system,
    loopback: backend.loopback, foreground: backend.foregroundCommands, loopsRunning: () => looper.runningCount(), events,
    autoPush: autoPushFn, autoPull: autoPullFn,
  });
  extras.telegram = telegram;
  // The agents' send_message and the digest go out through the bot.
  backend.notifications.addChannel({
    name: 'telegram',
    send: (text, context) => context?.sessionId ? telegram.notify(context.sessionId, text) : telegramChannel(settings).send(text),
  });
  void telegram.reconcile();

  // Session idle digest — a periodic notification listing sessions that
  // finished. Standalone timer, no dependency on the engine's turn machinery.
  backend.sessionTitler.writeTitle = writeTitle(oneShotDeps);
  const digest = new SessionDigest({
    sessions, cards, settings, oneShot: oneShotDeps, projects,
    channels: backend.notifications.channels(),
  });
  void digest.start();

  // Upgrade checker — periodic GitHub release check, notification via Telegram.
  // Waits one interval before the first check: the server may have just
  // restarted from an upgrade (checking immediately would find it current and
  // waste a GitHub API call). The interval is a setting read per tick, so a
  // change takes effect without a restart. 0 disables the check.
  (async () => {
    while (!backend.stopped) {
      const ms = await settings.resolve('update_check_interval_ms').catch(() => 86_400_000);
      if (Number(ms) <= 0) { await new Promise((r) => setTimeout(r, 60_000)); continue; }
      await new Promise((r) => setTimeout(r, Number(ms)));
      if (backend.stopped) break;
      await telegram.upgradeChecker.check()
        .catch((e) => log.warn({ err: errStr(e) }, 'upgrade check failed'));
    }
  })();

  const shutdown = async () => {
    // First: an update in flight ends its stream cleanly (this restart IS
    // the update) before app.close() force-closes every connection.
    updateShutdown();
    looper.stop();
    cronEngine.stop();
    digest.stop();
    await instantSync.stop();
    await backend.stop();
    process.exit(0);
  };
  await backend.httpApi.listen(env.port);
  log.info({ port: env.port, version: VERSION }, 'phantom-backend up');
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { log.error({ err: errStr(e) }, 'boot failed'); process.exit(1); });
