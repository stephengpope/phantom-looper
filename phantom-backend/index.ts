// Boot: env -> db -> migrations -> workspace dirs -> loops -> HTTP.
import { readEnv } from './env.js';
import { makeDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { makePaths } from './pool/paths.js';
import { bootCleanup, tick } from './pool/pool.js';
import { sweepSessions, loopOf } from './sessions.js';
import { buildApp, type AppCtx } from './api/app.js';
import { BoardEvents } from './api/boardEvents.js';
import { SessionEvents } from './api/sessionEvents.js';
import { makeDocker } from './docker.js';
import { migrateAllWorkspaceSchemas } from './db/workspaceSchema.js';
import { ContainerManager } from './workspace/container.js';
import { GitEngine } from './git/engine.js';
import { autoPush, type AutoPushEvent } from './git/autoPush.js';
import { autoPull, type AutoPullEvent } from './git/autoPull.js';
import type { ConflictContext } from './git/autoPush.js';
import { GIT_CLIENT_ID } from './git/git.js';
import { isProvider } from '../core/llm/createAgent.js';
import { openSession, SessionLockedError, type OpenedSession } from '../core/session.js';
import { runCodingTurn, settingsValues } from './looper/turn.js';
import { injectFetch } from './looper/injectFetch.js';
import { toCodingAgent } from '../core/llm/prompts/autoPush/wiring.js';
import { serializeTranscript } from '../core/llm/transcript.js';
import type { SyncDeps } from './git/sync.js';
import type { WorkspaceRow, SessionRow } from './db/schema.js';
import { LooperEngine } from './looper/engine.js';
import { TelegramEngine } from './telegram/engine.js';
import { resolve, resolveMany, resolveCredential, credentialForProvider } from './settings.js';
import { cascade } from '../core/llm/agentConfig.js';
import { getFolder } from './sessions.js';
import { refreshWorkState } from './git/workRefresh.js';
import { logger, errStr } from './log.js';

const log = logger('boot');
const VERSION = process.env.APP_VERSION ?? 'dev';
/** Host part of the in-process fetch shim's URLs — injectFetch ignores it, the
 *  same way the looper's 'http://looper' is ignored. */
const TURN_BASE = 'http://auto-push';

async function main() {
  const env = readEnv();
  const { pool: pgPool, db } = makeDb(env.databaseUrl);
  await migrate(pgPool);
  await migrateAllWorkspaceSchemas(pgPool);
  const paths = makePaths(env.workspaceRoot);
  await bootCleanup(paths);
  const docker = makeDocker();
  const containers = new ContainerManager(docker, paths, {
    volume: process.env.WORKSPACE_VOLUME, encryptionKey: env.encryptionKey,
  });
  await containers.bootCleanup();
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
      opened = await openSession({ baseUrl: TURN_BASE, apiKey: env.apiKey, clientId: GIT_CLIENT_ID,
        label: 'resolving a conflict', fetch: f, lock: true, sessionId: session.id });
    } catch (e) {
      if (e instanceof SessionLockedError) {
        log.warn({ session: session.id }, 'conflict turn could not open the session — it is busy');
        return false;
      }
      throw e;
    }
    const deps = { f, apiKey: env.apiKey, base: TURN_BASE, sessionEvents: sessionEvents,
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
  const engine = new GitEngine(db, paths, env.encryptionKey, resolveConflict);

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
      opened = await openSession({ baseUrl: TURN_BASE, apiKey: env.apiKey, clientId: GIT_CLIENT_ID,
        label: 'recording sync summary', fetch: f, lock: true, sessionId: session.id });
    } catch { return; }
    try {
      const messages = [...opened.messages, { role: 'user' as const, content: message }];
      const header = opened.header ?? {
        type: 'session' as const, agent: 'coding' as const,
        provider: '', model: '', created_at: new Date().toISOString(),
        session_id: session.id, workspace: workspace.id, branch: session.folderId ?? '',
      };
      await opened.saveTranscript(serializeTranscript(header, messages, opened.events));
    } finally {
      await opened.close().catch(() => {});
    }
  };

  // The auto-push commit message rides the ASSISTANT's model — the small-fast
  // slot; writing one subject line from a diff is not work for the model doing
  // the engineering. A config that cannot build (bad cascade pair, unknown
  // provider) just means the file-name fallback: a commit message degrades,
  // conflict resolution does not.
  const messageConfig = async () => {
    try {
      const cfg = await resolveMany(db,
        ['provider', 'model', 'base_url', 'assistant_provider', 'assistant_model', 'assistant_base_url']);
      const c = cascade(cfg, 'assistant');
      if (!isProvider(c.provider)) return null;
      const apiKey = await resolveCredential(db, env.encryptionKey, credentialForProvider(c.provider));
      return { ...c, provider: c.provider, apiKey };
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'assistant config cannot build — commit messages fall back to file names');
      return null;
    }
  };
  // When a sync comes back blocked and the session is running a card, the card
  // is blocked deterministically — the system decides, not the agent. The patch
  // goes through the API so board events fire and the UI updates.
  const blockCardOnConflict = async (session: SessionRow, workspace: WorkspaceRow, reason: string) => {
    const loop = await loopOf(db, session.id).catch(() => undefined);
    if (!loop) return;
    const r = await pgPool.query(
      `select id from "${workspace.schemaName}".cards where seq = $1`, [loop.card]);
    const card = r.rows[0] as { id: number } | undefined;
    if (!card) return;
    const f = injectFetch(app);
    await f(`${TURN_BASE}/workspaces/${workspace.id}/cards/${card.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${env.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'blocked', blocked_reason: reason, resolution: null }),
    }).catch((e) => log.warn({ session: session.id, err: errStr(e) }, 'could not block card after unresolved conflict'));
  };
  const syncDeps = { db, paths, encryptionKey: env.encryptionKey,
    resolve: resolveConflict, recordSummary, messageConfig };
  const autoPushFn = async (session: SessionRow, workspace: WorkspaceRow, onEvent?: (e: AutoPushEvent) => void | Promise<void>) => {
    const r = await autoPush({ ...syncDeps, onEvent }, session, workspace);
    if (r.result === 'blocked') await blockCardOnConflict(session, workspace,
      r.reason ?? 'a rebase conflict could not be resolved');
    return r;
  };
  // Auto-pull rides the same resolver and the same message model — one
  // configuration for every git operation that commits or resolves.
  const autoPullFn = async (session: SessionRow, workspace: WorkspaceRow, onEvent?: (e: AutoPullEvent) => void | Promise<void>) => {
    const r = await autoPull({ ...syncDeps, onEvent }, session, workspace);
    if (r.result === 'blocked') await blockCardOnConflict(session, workspace,
      r.reason ?? 'a rebase conflict could not be resolved');
    return r;
  };

  // One loop drives both the pool tick and the session sweep. The interval is a
  // SETTING read per tick, so a change takes effect without a restart.
  let stopped = false;
  (async () => {
    while (!stopped) {
      await tick(db, paths, env.encryptionKey).catch((e) => log.error({ err: errStr(e) }, 'pool tick threw'));
      await sweepSessions(db, paths).catch((e) => log.error({ err: errStr(e) }, 'session sweep threw'));
      const idleMs = await resolve(db, 'container_idle_ms').catch(() => 30 * 60_000);
      await containers.reap(Number(idleMs)).catch((e) => log.error({ err: errStr(e) }, 'container reap threw'));
      const ms = await resolve(db, 'maintenance_interval_ms').catch(() => 60_000);
      await new Promise((r) => setTimeout(r, Number(ms)));
    }
  })();

  // Board and session events, created here so the work-state loop below can
  // reference them before ctx is assigned (the loop sleeps 10s first, but
  // the references are captured at definition time).
  const events = new BoardEvents();
  const sessionEvents = new SessionEvents();

  // Work-state refresh: every 10s, recompute `work` for sessions with an
  // active container. A change writes the row and publishes on the board
  // event stream so the kanban board and the toolbar hear it live.
  (async () => {
    while (!stopped) {
      await new Promise((r) => setTimeout(r, 10_000));
      await refreshWorkState({ db, paths, containers, events, sessionEvents })
        .catch((e) => log.error({ err: errStr(e) }, 'work-state refresh threw'));
    }
  })();

  // `ctx` is a named object because the looper is wired into it AFTER the
  // app exists — the engine is a headless client of this app, so it is built
  // second; routes read ctx.looper per request, so the late set is seen.
  const ctx: AppCtx = {
    db, paths, apiKey: env.apiKey, encryptionKey: env.encryptionKey, version: VERSION,
    fs: { docker, containers, engine },
    engine,
    autoPush: autoPushFn,
    autoPull: autoPullFn,
    pgPool,
    events,
    sessionEvents,
    updateTriggerDir: process.env.UPDATE_TRIGGER_DIR || undefined,
  };
  const app = await buildApp(ctx);
  await app.listen({ port: env.port, host: '0.0.0.0' });
  log.info({ port: env.port, version: VERSION }, 'phantom-backend up');

  // The looper — built after listen: it is a headless
  // client of this server's own surface, and its rounds assume the routes
  // are answering. Event-driven: routes poke it through ctx.looper; start()
  // is ONE recovery sweep, not a poll.
  const looper = new LooperEngine({ db, pgPool, app, apiKey: env.apiKey, events: ctx.events,
    sessionEvents: ctx.sessionEvents, activeTurns: ctx.activeTurns });
  ctx.looper = looper;
  looper.start();

  // The Telegram engine — a client of this app like the looper. The webhook
  // URL is always https + PHANTOM_BACKEND_ADDRESS (the same fact the https
  // profile runs on); with no address, telegram stays off. Reconcile at boot
  // re-registers a stale webhook and pushes the command menu.
  const telegram = new TelegramEngine({
    db, paths, app, apiKey: env.apiKey, encryptionKey: env.encryptionKey,
    events: ctx.events,
    sessionEvents: ctx.sessionEvents, publicAddress: process.env.PHANTOM_BACKEND_ADDRESS,
  });
  ctx.telegram = telegram;
  void telegram.reconcile();

  // Upgrade checker — periodic GitHub release check, notification via Telegram.
  // Waits one interval before the first check: the server may have just
  // restarted from an upgrade (checking immediately would find it current and
  // waste a GitHub API call). The interval is a setting read per tick, so a
  // change takes effect without a restart. 0 disables the check.
  (async () => {
    while (!stopped) {
      const ms = await resolve(db, 'update_check_interval_ms').catch(() => 86_400_000);
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
    await app.close();
    await pgPool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { log.error({ err: errStr(e) }, 'boot failed'); process.exit(1); });
