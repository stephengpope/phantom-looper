// HTTP surface. One bearer token (API_KEY); every route requires it.
// Error bodies follow the envelope: the model's signal lives in the
// body ({ok:false, error:{code,message,retryable}}), never only in the status.
// Route schemas stay — they are Fastify's validation — but nothing serves
// them as documentation any more (Swagger UI was cut).
import Fastify from 'fastify';

// @fastify/swagger used to augment FastifySchema with these. The docs page is
// cut, but summary/description/tags stay on every route — they are the API's
// in-source documentation, and Fastify ignores them for validation.
declare module 'fastify' {
  interface FastifySchema { tags?: readonly string[]; summary?: string; description?: string }
}
import type { Paths } from '../pool/paths.js';
import { settingsRoutes } from './routes/settings.js';
import { secretsRoutes } from './routes/secrets.js';
import { fsRoutes, type FsDeps } from './routes/fs.js';
import { gitRoutes } from './routes/git.js';
import { kanbanRoutes } from './routes/kanban.js';
import { skillsRoutes } from './routes/skills.js';
import { webRoutes } from './routes/web.js';
import type { GitEngine } from '../git/engine.js';
import { BoardEvents } from './boardEvents.js';
import { SessionEvents } from './sessionEvents.js';
import type { Sessions } from '../sessions.js';
import type { Settings } from '../settings.js';
import type { Workspaces } from '../workspaces.js';
import type { Folders } from '../folders.js';
import type { Loops } from '../loops.js';
import type { Cards } from '../cards.js';
import type { Commands } from '../commands.js';
import type { Presets } from '../presets.js';
import type { TokenUsage } from '../tokenUsage.js';
import { SettingsEvents } from './settingsEvents.js';
import { ForegroundCommands } from './foreground.js';
import { BackdoorQueue } from './backdoor.js';
import type { AutoPushResult, AutoPushEvent } from '../git/autoPush.js';
import type { AutoPullResult, AutoPullEvent } from '../git/autoPull.js';
import type { WorkspaceRow, SessionRow } from '../db/schema.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { sessionRoutes } from './routes/sessions.js';
import { systemRoutes } from './routes/system.js';
import { tasksRoutes } from './routes/tasks.js';
import { telegramRoutes } from './routes/telegram.js';
import { presetRoutes } from './routes/presets.js';

export interface AppCtx {
  // The row owners — one object per table, each the ONLY door to its rows.
  // A route parses, checks, calls one method, shapes the reply; the rules
  // (and every change notice) live in the object.
  settings: Settings;
  workspaces: Workspaces;
  folders: Folders;
  loops: Loops;
  cards: Cards;
  sessions: Sessions;
  commands: Commands;
  presets: Presets;
  tokenUsage: TokenUsage;
  paths: Paths;
  apiKey: string;
  version: string;
  /** Docker wiring; absent in DB-only tests, and /fs then 404s. */
  fs?: FsDeps;
  engine?: GitEngine;
  /** Auto-push (git/autoPush.ts), wired in index.ts with the fixer and the
   *  message model. Absent in DB-only tests — the auto-push route answers 503
   *  and the archive trigger no-ops. */
  /** `by` is the caller's client id: every step also lands on the session's
   *  live feed, published under it, so the feed's echo rule skips the one
   *  window that already draws this stream. */
  autoPush?: (session: SessionRow, workspace: WorkspaceRow,
    onEvent?: (e: AutoPushEvent) => void | Promise<void>, by?: string) => Promise<AutoPushResult>;
  /** Auto-pull (git/autoPull.ts) — base INTO the branch, same fixer. Absent
   *  in DB-only tests: the auto-pull route answers 503. */
  autoPull?: (session: SessionRow, workspace: WorkspaceRow,
    onEvent?: (e: AutoPullEvent) => void | Promise<void>, by?: string) => Promise<AutoPullResult>;
  /** The board's event bus (boardEvents.ts) — the card routes publish, the
   *  events route streams, the looper engine publishes its pairings. index.ts
   *  makes one and hands it to both; a ctx built without one gets its own at
   *  registration, so every app can stream. */
  events?: BoardEvents;
  /** A session's live feed (sessionEvents.ts) — the server-side turn runner
   *  publishes every part, the transcript PUT publishes the record landing,
   *  and both GET /sessions/:id/events and the turn route read it. Defaulted
   *  at registration like the board's, so it is never absent: the turn
   *  route's own ND-JSON reply is built off it. */
  sessionEvents?: SessionEvents;
  /** Settings write notifications. The event names the scope only; listeners
   *  re-read the settings route rather than receiving a second copy. */
  settingsEvents?: SettingsEvents;
  /** Active server-side turns, keyed by session id. The interrupt route aborts
   *  the controller; the turn runner registers on entry and removes on exit.
   *  Absent only in tests that never run a turn. */
  activeTurns?: Map<string, AbortController>;
  /** In-flight foreground (unary bash) commands per session (foreground.ts).
   *  The interrupt route kills them: aborting the stream alone leaves the
   *  command running in the container for turns with no socket to close. */
  foreground?: ForegroundCommands;
  /** The backdoor message queue (backdoor.ts) — one-liners a session's
   *  NEXT turn carries without a turn being started for them (a detached
   *  command exiting, a file dropped onto the cli window). Defaulted at
   *  registration like the buses above. */
  backdoor?: BackdoorQueue;
  /** Where POST /update drops a release tag for the updater sidecar
   *  (UPDATE_TRIGGER_DIR). Absent: the route answers `updater_unavailable`. */
  updateTriggerDir?: string;
  /** Test seam: the fetch MODEL calls use (createAgent's own seam) — the turn
   *  route and the looper thread it through. Production never sets it. */
  modelFetch?: typeof fetch;
  /** The looper's event surface — set by index.ts AFTER the engine exists
   *  (the engine is a client of this app, so it is built second; routes read
   *  ctx.looper at request time, never at registration). The looper is
   *  event-driven, no polling: these calls are how card writes, supervision
   *  setting changes and lock releases reach it. Absent in tests — every
   *  call site guards with `?.`. */
  looper?: {
    /** A card was written — run its loop while it canTurn. */
    runLoop(workspaceId: string, cardNumber: number): void;
    /** A session lock was released — its card, if any, may be runnable.
     *  `releasedBy` is the releasing client id: the engine ignores its own
     *  releases (every turn ends in one — reacting would spin). */
    runLoopOfSession(sessionId: string, releasedBy: string): void;
    /** auto_plan/auto_build changed — run every loop in a workspace (or all). */
    runAllLoops(workspaceId?: string): void;
    /** Cards with a round in flight — GET /health's `loops_running`. */
    runningCount(): number;
  };
  /** The Telegram engine — set by index.ts AFTER listen (a client of this app
   *  like the looper). The webhook route calls handleUpdate; the settings
   *  routes poke reconcile() when a telegram_* key or the token is written.
   *  Absent in tests and when no public address is configured. */
  telegram?: {
    handleUpdate(secretHeader: string, update: unknown): Promise<number>;
    reconcile(): Promise<void>;
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
  // (`/sessions/:id/events`, `/workspaces/:id/events` — held open for as long
  // as a window watches). Fastify's default waits for active connections,
  // which is for ever here; the clients reconnect on their own (follow.ts).
  const app = Fastify({ logger: false, forceCloseConnections: true });

  // ── outer shell: reveal nothing ────────────────────────────────────────
  // Any request that lands outside /api gets a bare 401 with no body — no
  // envelope, no framework fingerprint, no confirmation that anything exists.
  // Scanners and probes learn nothing.
  app.setNotFoundHandler((_req, reply) => { reply.code(401).send(); });
  app.setErrorHandler((_e, _req, reply) => { reply.code(401).send(); });

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
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${ctx.apiKey}`) {
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

    ctx.sessionEvents ??= new SessionEvents();
    ctx.settingsEvents ??= new SettingsEvents();
    ctx.activeTurns ??= new Map();
    ctx.foreground ??= new ForegroundCommands();
    ctx.backdoor ??= new BackdoorQueue();
    settingsRoutes(api, ctx);
    secretsRoutes(api, ctx);
    workspaceRoutes(api, ctx);
    sessionRoutes(api, ctx);
    if (ctx.fs) fsRoutes(api, ctx, ctx.fs);
    if (ctx.fs) tasksRoutes(api, ctx, ctx.fs);
    if (ctx.fs) skillsRoutes(api, ctx, ctx.fs);
    if (ctx.fs && ctx.engine) gitRoutes(api, ctx, ctx.fs, ctx.engine);
    webRoutes(api, ctx);
    ctx.events ??= new BoardEvents();
    kanbanRoutes(api, ctx);
    systemRoutes(api, ctx);
    presetRoutes(api, ctx);
    telegramRoutes(api, ctx);
  }, { prefix: '/api' });

  return app;
}
