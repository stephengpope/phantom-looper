// HTTP surface. One bearer token (API_KEY); every route requires it.
// Error bodies follow the envelope: the model's signal lives in the
// body ({ok:false, error:{code,message,retryable}}), never only in the status.
// Route schemas stay — they are Fastify's validation — but nothing serves
// them as documentation any more (Swagger UI was cut).
import Fastify from 'fastify';
import { timingSafeEqualStr, type PhantomBackend } from 'phantom-backend-sdk';

// @fastify/swagger used to augment FastifySchema with these. The docs page is
// cut, but summary/description/tags stay on every route — they are the API's
// in-source documentation, and Fastify ignores them for validation.
declare module 'fastify' {
  interface FastifySchema { tags?: readonly string[]; summary?: string; description?: string }
}
import { settingsRoutes } from './routes/settings.js';
import { secretsRoutes } from './routes/secrets.js';
import { databaseRoutes } from './routes/database.js';
import type { FsDeps } from './routes/fs.js';
import { toolRoutes } from './routes/tools.js';
import { gitRoutes } from './routes/git.js';
import { kanbanRoutes } from './routes/kanban.js';
import { skillsRoutes } from './routes/skills.js';
import { webRoutes } from './routes/web.js';
import type { GitEngine } from '../git/engine.js';
import type { System } from '../system.js';
import type { AutoPushResult, AutoPushEvent } from '../git/autoPush.js';
import type { AutoPullResult, AutoPullEvent } from '../git/autoPull.js';
import type { ProjectRow, SessionRow } from 'phantom-backend-sdk/schema';
import { projectRoutes } from './routes/projects.js';
import { sessionRoutes } from './routes/sessions.js';
import { systemRoutes } from './routes/system.js';
import { tasksRoutes } from './routes/tasks.js';
import { telegramRoutes } from './routes/telegram.js';
import { presetRoutes } from './routes/presets.js';
import { cronRoutes } from './routes/crons.js';
import { dbUiRoutes } from './routes/dbUi.js';

/** What every route reads: the backend itself, plus what this app still
 *  wires around it. The extras are transitional — each leaves with the
 *  step named on it (docs/phantom-agent-sdk-plan.md). */
export type AppCtx = PhantomBackend & AppExtras;
export interface AppExtras {
  apiKey: string;
  /** Docker wiring for the file routes. → HttpApi (§4). */
  fs?: FsDeps;
  /** The manual git operations and the two auto syncs. → GitSync (§4). */
  engine?: GitEngine;
  autoPush?: (session: SessionRow, project: ProjectRow,
    onEvent?: (e: AutoPushEvent) => void | Promise<void>, by?: string) => Promise<AutoPushResult>;
  autoPull?: (session: SessionRow, project: ProjectRow,
    onEvent?: (e: AutoPullEvent) => void | Promise<void>, by?: string) => Promise<AutoPullResult>;
  /** This backend's own housekeeping — logs, status, restart, token report. → Upgrader (§4). */
  system: System;
  /** Where POST /update drops a release tag for the updater sidecar. → Upgrader (§4). */
  updateTriggerDir?: string;
  /** Test seam: the fetch MODEL calls use. Goes with core/llm (§7). */
  modelFetch?: typeof fetch;
  /** The looper's event surface — user space, set after the app exists. → the route door (§5). */
  looper?: {
    runLoopOfSession(sessionId: string, releasedBy: string): void;
    runAllLoops(projectId?: string): void;
    runningCount(): number;
  };
  /** The Telegram engine — user space, set after listen. → TelegramBot.onUpdate (§6). */
  telegram?: {
    handleUpdate(secretHeader: string, update: unknown): Promise<number>;
    reconcile(): Promise<void>;
    notify(sessionId: string, text: string): Promise<void>;
  };
}

export function err(code: string, message: string, retryable = false, detail?: unknown) {
  return { ok: false as const, error: { code, message, retryable, ...(detail === undefined ? {} : { detail }) } };
}
export function ok<T>(data: T) {
  return { ok: true as const, data };
}

export async function buildApp(ctx: AppCtx) {
  // forceCloseConnections: a shutdown must not wait on the live feeds
  // (`/sessions/:id/events`, `/projects/:id/events` — held open for as long
  // as a window watches). Fastify's default waits for active connections,
  // which is for ever here; the clients reconnect on their own (follow.ts).
  const app = Fastify({ logger: false, forceCloseConnections: true });

  // ── outer shell: reveal nothing ────────────────────────────────────────
  // Any request that lands outside /api and /db gets a bare 401 with no
  // body — no envelope, no framework fingerprint, no confirmation that
  // anything exists. Scanners and probes learn nothing.
  app.setNotFoundHandler((_req, reply) => { reply.code(401).send(); });
  app.setErrorHandler((_e, _req, reply) => { reply.code(401).send(); });

  // ── /db: the database console ─────────────────────────────────────────
  // CloudBeaver, proxied. Basic auth (phantom_admin + the API key), not
  // bearer — a browser cannot send bearer by typing a URL. The route's own
  // onRequest hook handles auth and the db_ui_enabled gate.
  dbUiRoutes(app, ctx.settings, ctx.apiKey);

  // ── /api: the real surface ─────────────────────────────────────────────
  await app.register(async (api) => {
    api.get('/health', { schema: { tags: ['meta'], summary: 'Liveness',
      description: 'Requires the bearer token. Returns the running version — watch it change after POST /update — ' +
        'and `loops_running`, the cards with a round in flight (a restart interrupts those rounds; they resume after boot).' } },
    async () => ({ ok: true, version: ctx.version, loops_running: ctx.looper?.runningCount() ?? 0 }));

    api.addHook('onRequest', async (req, reply) => {
      // The Telegram webhook is public: Telegram cannot send our bearer, and
      // its own secret-token header (timing-safe-checked in the engine) is the
      // auth.
      if (req.url === '/api/telegram/webhook') return;
      const auth = String(req.headers.authorization ?? '');
      if (!timingSafeEqualStr(auth, `Bearer ${ctx.apiKey}`)) {
        return reply.code(401).send();
      }
    });

    // Unknown routes inside /api speak the envelope — the model may probe a
    // tool name that does not exist and must get {ok:false,error:{code:'not_found'}}.
    api.setNotFoundHandler((req, reply) => {
      reply.code(404).send(err('not_found', `no route ${req.method} ${req.url}`));
    });

    api.setErrorHandler((e: unknown, _req, reply) => {
      // Schema validation failures speak the same envelope as everything else —
      // the model reads {ok:false,error:{...}}, never a framework error shape.
      const fe = e as { validation?: unknown; message?: string };
      if (fe.validation) {
        return reply.code(400).send(err('invalid_args', fe.message ?? 'invalid arguments'));
      }
      reply.code(500).send(err('internal', e instanceof Error ? e.message : String(e)));
    });

    settingsRoutes(api, ctx);
    secretsRoutes(api, ctx);
    projectRoutes(api, ctx);
    databaseRoutes(api, ctx);
    sessionRoutes(api, ctx);
    toolRoutes(api, ctx);
    if (ctx.fs) tasksRoutes(api, ctx, ctx.fs);
    if (ctx.fs) skillsRoutes(api, ctx, ctx.fs);
    if (ctx.fs && ctx.engine) gitRoutes(api, ctx, ctx.fs, ctx.engine);
    webRoutes(api, ctx);
    kanbanRoutes(api, ctx);
    systemRoutes(api, ctx);
    presetRoutes(api, ctx);
    cronRoutes(api, ctx);
    telegramRoutes(api, ctx);
  }, { prefix: '/api' });

  return app;
}
