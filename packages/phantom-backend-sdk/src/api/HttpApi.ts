// HttpApi — the HTTP surface: Fastify, one bearer key on every route, the
// envelope ({ok, data} / {ok:false, error:{code, message, retryable}}), the
// SDK's routes, and the door user space adds its own through (same auth,
// same envelope). The database console rides beside it at /db.
//
// Any request that lands outside /api and /db gets a bare 401 with no body —
// no envelope, no framework fingerprint, no confirmation that anything exists.
//
// summary/description/tags stay on every route — they are the API's
// in-source documentation; Fastify ignores them for validation.
declare module 'fastify' {
  interface FastifySchema { tags?: readonly string[]; summary?: string; description?: string }
}
import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqualStr } from '../lib/crypto.js';
import type { PhantomBackend } from '../PhantomBackend.js';
import type { RouteRegistrar } from '../doors.js';
import { settingsRoutes } from './routes/settings.js';
import { secretsRoutes } from './routes/secrets.js';
import { projectRoutes } from './routes/projects.js';
import { databaseRoutes } from './routes/database.js';
import { sessionRoutes } from './routes/sessions.js';
import { toolRoutes } from './routes/tools.js';
import { tasksRoutes } from './routes/tasks.js';
import { skillsRoutes } from './routes/skills.js';
import { webRoutes } from './routes/web.js';
import { kanbanRoutes } from './routes/kanban.js';
import { presetRoutes } from './routes/presets.js';
import { cronRoutes } from './routes/crons.js';
import { dbUiRoutes } from './routes/dbUi.js';

export function err(code: string, message: string, retryable = false, detail?: unknown) {
  return { ok: false as const, error: { code, message, retryable, ...(detail === undefined ? {} : { detail }) } };
}
export function ok<T>(data: T) {
  return { ok: true as const, data };
}

/** Paths the bearer check skips: a webhook whose sender cannot carry our
 *  key and brings its own secret instead. User space adds its own. */
export class HttpApi {
  readonly app: FastifyInstance;
  readonly #public = new Set<string>();
  #registrars: RouteRegistrar[] = [];

  constructor(private readonly backend: PhantomBackend, private readonly apiKey: string) {
    // forceCloseConnections: a shutdown must not wait on the live feeds (held
    // open for as long as a window watches); the clients reconnect on their own.
    this.app = Fastify({ logger: false, forceCloseConnections: true });
  }

  /** Register user space's routes, after the SDK's, under the same auth.
   *  Before `listen`. */
  addRoutes(registrar: RouteRegistrar): void { this.#registrars.push(registrar); }
  /** A route under /api the bearer check skips (the Telegram webhook). */
  addPublicPath(path: string): void { this.#public.add(path); }

  #built = false;

  /** Register every route — the SDK's, then user space's. Once; before
   *  `listen`, and before anything calls the API in-process. */
  async build(): Promise<void> {
    if (this.#built) return;
    this.#built = true;
    const { app, backend } = this;
    app.setNotFoundHandler((_req, reply) => { reply.code(401).send(); });
    app.setErrorHandler((_e, _req, reply) => { reply.code(401).send(); });

    // /db: CloudBeaver, proxied. Basic auth (phantom_admin + the API key),
    // not bearer — a browser cannot send bearer by typing a URL.
    dbUiRoutes(app, backend.settings, this.apiKey);

    await app.register(async (api) => {
      api.get('/health', { schema: { tags: ['meta'], summary: 'Liveness',
        description: 'Requires the bearer token. Returns the running version and `loops_running`, the card runs in flight.' } },
      async () => ({ ok: true, version: backend.version, loops_running: backend.hooks.runningLoops?.() ?? 0 }));

      api.addHook('onRequest', async (req, reply) => {
        if (this.#public.has(req.url)) return;
        const auth = String(req.headers.authorization ?? '');
        if (!timingSafeEqualStr(auth, `Bearer ${this.apiKey}`)) return reply.code(401).send();
      });
      // Unknown routes inside /api speak the envelope — the model may probe a tool name that does not exist.
      api.setNotFoundHandler((req, reply) => { reply.code(404).send(err('not_found', `no route ${req.method} ${req.url}`)); });
      api.setErrorHandler((e: unknown, _req, reply) => {
        const fe = e as { validation?: unknown; message?: string };
        if (fe.validation) return reply.code(400).send(err('invalid_args', fe.message ?? 'invalid arguments'));
        reply.code(500).send(err('internal', e instanceof Error ? e.message : String(e)));
      });

      settingsRoutes(api, backend);
      secretsRoutes(api, backend);
      projectRoutes(api, backend);
      databaseRoutes(api, backend);
      sessionRoutes(api, backend);
      toolRoutes(api, backend);
      tasksRoutes(api, backend);
      skillsRoutes(api, backend);
      webRoutes(api, backend);
      kanbanRoutes(api, backend);
      presetRoutes(api, backend);
      cronRoutes(api, backend);
      for (const registrar of this.#registrars) await registrar(api);
    }, { prefix: '/api' });
  }

  async listen(port: number, host = '0.0.0.0'): Promise<void> {
    await this.build();
    await this.app.listen({ port, host });
  }

  async close(): Promise<void> { await this.app.close(); }
}
