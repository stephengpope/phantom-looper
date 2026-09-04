// Boot: env -> db -> migrations -> workspace dirs -> loops -> HTTP.
import { readEnv } from './env.js';
import { makeDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { makePaths } from './pool/paths.js';
import { bootCleanup, tick } from './pool/pool.js';
import { sweepSessions } from './sessions.js';
import { buildApp, type AppCtx } from './api/app.js';
import { BoardEvents } from './api/boardEvents.js';
import { makeDocker } from './docker.js';
import { migrateAllWorkspaceSchemas } from './db/workspaceSchema.js';
import { ContainerManager } from './workspace/container.js';
import { GitEngine } from './git/engine.js';
import { autoPush, type AutoPushEvent } from './git/autoPush.js';
import { Sandbox } from './workspace/sandbox.js';
import { AiSdkGitFixerDriver, runGitFixer } from './git/gitFixer.js';
import { isProvider } from '../core/llm/createAgent.js';
import type { WorkspaceRow, SessionRow } from './db/schema.js';
import { LooperEngine } from './looper/engine.js';
import { TelegramEngine } from './telegram/engine.js';
import { resolve, resolveMany, resolveCredential, credentialForProvider } from './settings.js';
import { cascade } from '../core/llm/agentConfig.js';
import { getFolder } from './sessions.js';
import { logger, errStr } from './log.js';

const log = logger('boot');
const VERSION = process.env.APP_VERSION ?? 'dev';

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
  // The Git Fixer's trio cascades to the coding agent's (core agentModelConfig
  // rule: a field inherits only while the provider matches). A bad pair —
  // provider overridden, no model — throws HERE, and the auto-push/pull that
  // needed the fixer reports it; the key is the row for whichever provider won.
  const gitFixerConfig = async () => {
    const cfg = await resolveMany(db,
      ['provider', 'model', 'base_url', 'git_fixer_provider', 'git_fixer_model', 'git_fixer_base_url']);
    const c = cascade(cfg, 'git_fixer');
    return { ...c, apiKey: await resolveCredential(db, env.encryptionKey, credentialForProvider(c.provider)) };
  };
  const gitFixerDriver = new AiSdkGitFixerDriver(gitFixerConfig);
  // The Git Fixer hook, shared by auto-push and manual /git/pull. Its shell runs in
  // the workspace container: model-driven commands over conflicted content
  // belong in the most-contained place. Unconditional — auto-push resolves
  // conflicts whenever it runs; it always fixes when it runs.
  const fixerHook = async (session: SessionRow, workspace: WorkspaceRow, dir: string) => {
    const container = await containers.ensure(db, session, workspace);
    const ws = new Sandbox(docker, container);
    const exec = async (cmd: string) => {
      const r = await ws.run(['/bin/sh', '-c', cmd], { timeoutMs: 120_000 });
      return { stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8'), exitCode: r.exitCode };
    };
    const folder = session.folderId ? await getFolder(db, session.folderId) : undefined;
    if (!folder) return false;
    return runGitFixer(dir, exec, folder.branch, gitFixerDriver, {
      attempts: Number(await resolve(db, 'auto_push_fix_attempts')),
    }, session.id, workspace.baseBranch);
  };
  const engine = new GitEngine(db, paths, env.encryptionKey, fixerHook);

  // The auto-push commit message rides the Git Fixer's model config; a config
  // that cannot build (bad cascade pair, unknown provider) just means the
  // file-name fallback — a commit message degrades, conflict fixing does not.
  const messageConfig = async () => {
    try {
      const c = await gitFixerConfig();
      if (!isProvider(c.provider)) return null;
      return { ...c, provider: c.provider };
    } catch { return null; }
  };
  const autoPushFn = (session: SessionRow, workspace: WorkspaceRow, onEvent?: (e: AutoPushEvent) => void | Promise<void>) =>
    autoPush({ db, paths, encryptionKey: env.encryptionKey, fixer: fixerHook, messageConfig, onEvent },
      session, workspace);

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

  // `ctx` is a named object because the looper is wired into it AFTER the
  // app exists — the engine is a headless client of this app, so it is built
  // second; routes read ctx.looper per request, so the late set is seen.
  const ctx: AppCtx = {
    db, paths, apiKey: env.apiKey, encryptionKey: env.encryptionKey, version: VERSION,
    fs: { docker, containers, engine },
    engine,
    autoPush: autoPushFn,
    pgPool,
    events: new BoardEvents(),
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
    sessionEvents: ctx.sessionEvents });
  ctx.looper = looper;
  looper.start();

  // The Telegram engine — a client of this app like the looper. The webhook
  // URL is always https + PHANTOM_BACKEND_ADDRESS (the same fact the https
  // profile runs on); with no address, telegram stays off. Reconcile at boot
  // re-registers a stale webhook and pushes the command menu.
  const telegram = new TelegramEngine({
    db, paths, app, apiKey: env.apiKey, encryptionKey: env.encryptionKey,
    sessionEvents: ctx.sessionEvents, publicAddress: process.env.PHANTOM_BACKEND_ADDRESS,
  });
  ctx.telegram = telegram;
  void telegram.reconcile();

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
