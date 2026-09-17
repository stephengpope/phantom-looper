// Boot: env -> db -> migrations -> workspace dirs -> looper -> HTTP.
import { readEnv } from './env.js';
import { makeDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { makePaths } from './pool/paths.js';
import { bootCleanup, tick } from './pool/pool.js';
import { Sessions } from './sessions.js';
import { Settings } from './settings.js';
import { Workspaces } from './workspaces.js';
import { Folders } from './folders.js';
import { Cards } from './cards.js';
import { BackgroundTasks } from './backgroundTasks.js';
import { Presets } from './presets.js';
import { setTokenRecorder } from '../core/llm/createAgent.js';
import { LogTokens } from './logTokens.js';
import { TelegramState } from './telegram/store.js';
import { SettingsEvents } from './api/settingsEvents.js';
import { idleBackupSweep, pressureSweep } from './disk.js';
import { buildApp, type AppCtx } from './api/app.js';
import { BoardEvents } from './api/boardEvents.js';
import { SessionEvents } from './api/sessionEvents.js';
import { BackdoorQueue } from './api/backdoor.js';
import { makeDocker } from './docker.js';
import { ContainerManager } from './workspace/container.js';
import { GitEngine } from './git/engine.js';
import { autoPush, type AutoPushEvent } from './git/autoPush.js';
import { autoPull, type AutoPullEvent } from './git/autoPull.js';
import type { ConflictContext } from './git/autoPush.js';
import { GIT_CLIENT_ID } from './git/git.js';
import { isProvider } from '../core/llm/createAgent.js';
import { SessionDigest } from './notifications/digest.js';
import { telegramChannel } from './notifications/telegramChannel.js';
import { openSession, SessionLockedError, type OpenedSession } from '../core/session.js';
import { runCodingTurn, settingsValues } from './looper/turn.js';
import { injectFetch } from './looper/injectFetch.js';
import { toCodingAgent } from '../core/llm/prompts/autoPush/wiring.js';
import { serializeTranscript } from '../core/llm/transcript.js';
import type { SyncDeps, SyncEvent } from './git/sync.js';
import type { WorkspaceRow, SessionRow } from './db/schema.js';
import { LooperEngine } from './looper/engine.js';
import { TelegramEngine } from './telegram/engine.js';
import { credentialForProvider } from './settings.js';
import { cascade } from '../core/llm/agentConfig.js';
import { refreshWorkState } from './git/workRefresh.js';
import { logger, errStr } from './log.js';

const log = logger('boot');
const VERSION = process.env.APP_VERSION ?? 'dev';
/** Fake base URL for in-process API calls via injectFetch — the host part is
 *  discarded, only the /api path prefix matters. */
const INTERNAL_API = 'http://internal/api';

async function main() {
  const env = readEnv();
  const { pool: pgPool, db } = makeDb(env.databaseUrl);
  await migrate(pgPool);
  const paths = makePaths(env.workspaceRoot);
  await bootCleanup(paths);

  // The event buses, then THE ROW OWNERS over them — one object per table,
  // built once here in dependency order and handed to everything else. No
  // module below reads or writes a table any other way, so every rule and
  // every change notice has exactly one home.
  const events = new BoardEvents();
  const sessionEvents = new SessionEvents();
  const settingsEvents = new SettingsEvents();
  const settings = new Settings(db, env.encryptionKey, settingsEvents);
  const workspaces = new Workspaces(db, settings, settingsEvents);
  const folders = new Folders(db);
  const cards = new Cards(db, events);
  const sessions = new Sessions(db, paths, settings, workspaces, folders, sessionEvents);
  // A settings write reaches every session nothing has been said to yet: its
  // row takes the settings' model (Sessions.followModelSettings — THE rule).
  settingsEvents.subscribe(() => {
    sessions.followModelSettings().catch((e) => log.warn({ err: (e as Error).message }, 'newborn sessions could not follow the model settings'));
  });
  const backgroundTasks = new BackgroundTasks(db);
  const presets = new Presets(db);
  const logTokens = new LogTokens(db);
  // Every model call in this process records here (core languageModel).
  setTokenRecorder((r) => {
    logTokens.record(r).catch((e) => log.warn({ err: (e as Error).message }, 'token recording failed'));
  });
  const telegramState = new TelegramState(db, env.encryptionKey);

  const docker = makeDocker();
  const containers = new ContainerManager(docker, paths, {
    volume: process.env.WORKSPACE_VOLUME, settings,
  });
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
  const resolveConflict = async (
    session: SessionRow, workspace: WorkspaceRow, _dir: string, ctx: ConflictContext,
  ): Promise<boolean> => {
    const f = injectFetch(app);
    // The SAME client id auto-push locks under — a holder may re-take its own
    // hold, and any other id would find the session locked by us.
    let opened: OpenedSession;
    try {
      opened = await openSession({ baseUrl: INTERNAL_API, apiKey: env.apiKey, clientId: GIT_CLIENT_ID,
        label: 'resolving a conflict', fetch: f, lock: true, sessionId: session.id });
    } catch (e) {
      if (e instanceof SessionLockedError) {
        log.warn({ session: session.id }, 'conflict turn could not open the session — it is busy');
        return false;
      }
      throw e;
    }
    const deps = { f, apiKey: env.apiKey, base: INTERNAL_API, sessionEvents: sessionEvents,
      backdoor,
      client: GIT_CLIENT_ID, onRetry: (t: string) => log.warn({ session: session.id }, t) };
    try {
      const message = toCodingAgent.resolveConflict(
        ctx.branch, ctx.baseBranch, ctx.files, ctx.arrived);
      // planMode false: resolving means writing files.
      await runCodingTurn(deps, opened, workspace.id, message, false, await settingsValues(deps));
      return true;
    } catch (e) {
      log.error({ session: session.id, err: errStr(e) }, 'conflict turn failed');
      return false;
    } finally {
      await opened.close().catch(() => {});
    }
  };
  // The sync's commit message rides the ASSISTANT's model — the small-fast
  // slot; writing one subject line from a diff is not work for the model doing
  // the engineering. A config that cannot build THROWS, and the sync fails
  // with that reason: there is no file-name fallback anywhere — a commit
  // message that cannot be written is a broken setup the person must hear
  // about, not paper over. Shared by auto-push, auto-pull and the manual
  // pull (the engine below).
  // `report` comes from the sync (it streams each note as a commit-step
  // event); onRetry is what makes the retry loop's waits VISIBLE — without
  // it the call retried in silence, which was the original bug.
  const messageConfig: SyncDeps['messageConfig'] = async (report) => {
    const cfg = await settings.resolveMany(
      ['provider', 'model', 'base_url', 'assistant_provider', 'assistant_model', 'assistant_base_url']);
    const c = cascade(cfg, 'assistant'); // a bad pair throws with the fix in the message
    if (!isProvider(c.provider)) return null;
    const apiKey = await settings.credential(credentialForProvider(c.provider));
    const onRetry = (note: string) => { log.warn(`commit message: ${note}`); report?.(note); };
    return { ...c, provider: c.provider, apiKey, onRetry };
  };
  // Every sync step also lands on the session's live feed, so a window
  // WATCHING the session sees the sync whoever kicked it off — a card
  // archive fires one detached, with no stream of its own. Published under
  // the caller's own client id (`by`) when the call came from a route: the
  // feed's echo rule then skips the one window that already draws the
  // stream it asked for. `sessionEvents` is captured lazily, like `app`.
  const publishSync = (sessionId: string, op: 'push' | 'pull', by?: string) =>
    (e: SyncEvent) => sessionEvents.publish(sessionId, by || GIT_CLIENT_ID,
      { event: 'sync', op, step: e.step, detail: e.detail });
  // The manual /git/pull has no stream of its own — the feed is how anyone
  // sees it run, so its steps publish under the git client (no caller to echo).
  const engine = new GitEngine({ sessions, folders, cards, settings, paths,
    resolve: resolveConflict, messageConfig }, (sessionId, e) => publishSync(sessionId, 'pull')(e));

  // After a successful sync, drop a summary into the session's transcript so
  // the coding agent knows what happened on its next turn. Same lock, same
  // openSession pattern as the conflict resolver — the sync still holds the
  // session under GIT_CLIENT_ID when this runs.
  const recordSummary: SyncDeps['recordSummary'] = async (session, workspace, result, opts) => {
    if (result.outcome !== 'ok') return;
    const message = toCodingAgent.syncSummary(
      workspace.baseBranch, opts.landOnBase, result.arrived ?? [], result.files ?? []);
    const f = injectFetch(app);
    let opened: OpenedSession;
    try {
      opened = await openSession({ baseUrl: INTERNAL_API, apiKey: env.apiKey, clientId: GIT_CLIENT_ID,
        label: 'recording sync summary', fetch: f, lock: true, sessionId: session.id });
    } catch { return; }
    try {
      const messages = [...opened.messages, { role: 'user' as const, content: message }];
      await opened.saveTranscript(serializeTranscript(messages, opened.events));
    } finally {
      await opened.close().catch(() => {});
    }
  };


  // When a sync comes back blocked and the session is running a card, the card
  // is blocked deterministically — the system decides, not the agent. The patch
  // goes through the API so board events fire and the UI updates.
  const blockCardOnConflict = async (session: SessionRow, workspace: WorkspaceRow, reason: string) => {
    const card = await cards.ofSession(session.id).catch(() => undefined);
    if (!card) return;
    const f = injectFetch(app);
    await f(`${INTERNAL_API}/workspaces/${workspace.id}/cards/${card.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${env.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'blocked', blocked_reason: reason, resolution: null }),
    }).catch((e) => log.warn({ session: session.id, err: errStr(e) }, 'could not block card after unresolved conflict'));
  };
  const syncDeps = { sessions, folders, cards, settings, paths,
    resolve: resolveConflict, recordSummary, messageConfig };
  const autoPushFn = async (session: SessionRow, workspace: WorkspaceRow,
    onEvent?: (e: AutoPushEvent) => void | Promise<void>, by?: string) => {
    const publish = publishSync(session.id, 'push', by);
    const r = await autoPush({ ...syncDeps,
      onEvent: async (e) => { publish(e); await onEvent?.(e); } }, session, workspace);
    if (r.result === 'blocked') await blockCardOnConflict(session, workspace,
      r.reason ?? 'a rebase conflict could not be resolved');
    return r;
  };
  // Auto-pull rides the same resolver and the same message model — one
  // configuration for every git operation that commits or resolves.
  const autoPullFn = async (session: SessionRow, workspace: WorkspaceRow,
    onEvent?: (e: AutoPullEvent) => void | Promise<void>, by?: string) => {
    const publish = publishSync(session.id, 'pull', by);
    const r = await autoPull({ ...syncDeps,
      onEvent: async (e) => { publish(e); await onEvent?.(e); } }, session, workspace);
    if (r.result === 'blocked') await blockCardOnConflict(session, workspace,
      r.reason ?? 'a rebase conflict could not be resolved');
    return r;
  };

  // One loop drives both the pool tick and the session sweep. The interval is a
  // SETTING read per tick, so a change takes effect without a restart.
  // Sessions with a running container whose lastUsedAt is past the threshold
  // and have no running background tasks — the set safe to reap.
  const idleContainerSessions = async (ms: number): Promise<string[]> => {
    const active = await containers.activeSessions();
    const idle = await sessions.listIdle(active, ms);
    const busy = await backgroundTasks.sessionsWithRunning(idle);
    return idle.filter((id) => !busy.has(id));
  };

  let stopped = false;
  (async () => {
    while (!stopped) {
      await tick(workspaces, settings, paths).catch((e) => log.error({ err: errStr(e) }, 'pool tick threw'));
      await idleBackupSweep(workspaces, sessions, engine).catch((e) => log.error({ err: errStr(e) }, 'idle backup sweep threw'));
      const idleMs = await settings.resolve('container_idle_ms').catch(() => 30 * 60_000);
      await containers.reap(Number(idleMs), idleContainerSessions).catch((e) => log.error({ err: errStr(e) }, 'container reap threw'));
      await pressureSweep(settings, workspaces, sessions, paths, docker, containers, engine, idleContainerSessions).catch((e) => log.error({ err: errStr(e) }, 'pressure sweep threw'));
      const ms = await settings.resolve('maintenance_interval_ms').catch(() => 60_000);
      await new Promise((r) => setTimeout(r, Number(ms)));
    }
  })();

  const backdoor = new BackdoorQueue();

  // Work-state refresh: every 10s, recompute `work` for sessions with an
  // active container. A change writes the row and publishes on the board
  // event stream so the kanban board and the toolbar hear it live.
  (async () => {
    while (!stopped) {
      await new Promise((r) => setTimeout(r, 10_000));
      await refreshWorkState({ sessions, workspaces, folders, paths, containers, events })
        .catch((e) => log.error({ err: errStr(e) }, 'work-state refresh threw'));
    }
  })();

  // `ctx` is a named object because the looper is wired into it AFTER the
  // app exists — the engine is a headless client of this app, so it is built
  // second; routes read ctx.looper per request, so the late set is seen.
  const ctx: AppCtx = {
    settings, workspaces, folders, cards, sessions, backgroundTasks, presets, logTokens,
    paths, apiKey: env.apiKey, version: VERSION,
    fs: { docker, containers, engine },
    engine,
    autoPush: autoPushFn,
    autoPull: autoPullFn,
    events,
    sessionEvents,
    settingsEvents,
    backdoor,
    updateTriggerDir: process.env.UPDATE_TRIGGER_DIR || undefined,
  };
  const app = await buildApp(ctx);
  await app.listen({ port: env.port, host: '0.0.0.0' });
  log.info({ port: env.port, version: VERSION }, 'phantom-backend up');

  // The looper — built after listen: it is a headless
  // client of this server's own surface, and its rounds assume the routes
  // are answering. Event-driven: routes poke it through ctx.looper; start()
  // is ONE recovery sweep, not a poll.
  const looper = new LooperEngine({ sessions, workspaces, cards, settings, app, apiKey: env.apiKey, events: ctx.events,
    sessionEvents: ctx.sessionEvents, activeTurns: ctx.activeTurns, backdoor: ctx.backdoor });
  ctx.looper = looper;
  looper.start();

  // The Telegram engine — a client of this app like the looper. The webhook
  // URL is always https + PHANTOM_BACKEND_ADDRESS (the same fact the https
  // profile runs on); with no address, telegram stays off. Reconcile at boot
  // re-registers a stale webhook and pushes the command menu.
  const telegram = new TelegramEngine({
    state: telegramState, settings, sessions, cards, workspaces, paths, app, apiKey: env.apiKey,
    events: ctx.events, backdoor: ctx.backdoor,
    sessionEvents: ctx.sessionEvents, publicAddress: process.env.PHANTOM_BACKEND_ADDRESS,
    autoPush: autoPushFn, autoPull: autoPullFn,
  });
  ctx.telegram = telegram;
  void telegram.reconcile();

  // Session idle digest — a periodic notification listing sessions that
  // finished. Standalone timer, no dependency on the engine's turn machinery.
  const digest = new SessionDigest({
    sessions, cards, settings, workspaces,
    channels: [telegramChannel(settings)],
  });
  void digest.start();

  // Upgrade checker — periodic GitHub release check, notification via Telegram.
  // Waits one interval before the first check: the server may have just
  // restarted from an upgrade (checking immediately would find it current and
  // waste a GitHub API call). The interval is a setting read per tick, so a
  // change takes effect without a restart. 0 disables the check.
  (async () => {
    while (!stopped) {
      const ms = await settings.resolve('update_check_interval_ms').catch(() => 86_400_000);
      if (Number(ms) <= 0) { await new Promise((r) => setTimeout(r, 60_000)); continue; }
      await new Promise((r) => setTimeout(r, Number(ms)));
      if (stopped) break;
      await telegram.upgradeChecker.check()
        .catch((e) => log.warn({ err: errStr(e) }, 'upgrade check failed'));
    }
  })();

  const shutdown = async () => {
    stopped = true;
    looper.stop();
    digest.stop();
    await app.close();
    await pgPool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { log.error({ err: errStr(e) }, 'boot failed'); process.exit(1); });
