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
import { gitRoutes } from './routes/git.js';
import { telegramRoutes, TELEGRAM_WEBHOOK_PATH } from './routes/telegram.js';
import { SDK_VERSION } from '../sdkVersion.js';

export function err(code: string, message: string, retryable = false, detail?: unknown) {
  return { ok: false as const, error: { code, message, retryable, ...(detail === undefined ? {} : { detail }) } };
}
export function ok<T>(data: T) {
  return { ok: true as const, data };
}

/** The one path the bearer check skips: the Telegram webhook, whose sender
 *  cannot carry our key and brings its own secret instead. */
const PUBLIC_PATHS = new Set([`/api${TELEGRAM_WEBHOOK_PATH}`]);

export class HttpApi {
  readonly #app: FastifyInstance;

  constructor(private readonly backend: PhantomBackend, private readonly apiKey: string,
    /** User space's routes, registered after the SDK's under the same auth. */
    private readonly routes?: RouteRegistrar) {
    // forceCloseConnections: a shutdown must not wait on the live feeds (held
    // open for as long as a window watches); the clients reconnect on their own.
    this.#app = Fastify({ logger: false, forceCloseConnections: true });
  }

  /** Register every route — the SDK's, then user space's. */
  async #build(): Promise<void> {
    const { backend } = this;
    const app = this.#app;
    app.setNotFoundHandler((_req, reply) => { reply.code(401).send(); });
    app.setErrorHandler((_error, _req, reply) => { reply.code(401).send(); });

    // /db: CloudBeaver, proxied. Basic auth (phantom_admin + the API key),
    // not bearer — a browser cannot send bearer by typing a URL.
    dbUiRoutes(app, backend.settings, this.apiKey);

    await app.register(async (api) => {
      api.get('/health', { schema: { tags: ['meta'], summary: 'Liveness',
        description: 'Requires the bearer token. Returns the running version, the backend SDK\'s version (`sdk_version` — the client SDK refuses a backend on another), plus what the app reports (config.health).' } },
      async () => ({ ok: true, version: backend.version, sdk_version: SDK_VERSION, ...backend.healthExtras() }));

      api.addHook('onRequest', async (req, reply) => {
        if (PUBLIC_PATHS.has(req.url)) return;
        const auth = String(req.headers.authorization ?? '');
        if (!timingSafeEqualStr(auth, `Bearer ${this.apiKey}`)) return reply.code(401).send();
      });
      // Unknown routes inside /api speak the envelope — the model may probe a tool name that does not exist.
      api.setNotFoundHandler((req, reply) => { reply.code(404).send(err('not_found', `no route ${req.method} ${req.url}`)); });
      api.setErrorHandler((error: unknown, _req, reply) => {
        const fastifyError = error as { validation?: unknown; message?: string };
        if (fastifyError.validation) return reply.code(400).send(err('invalid_args', fastifyError.message ?? 'invalid arguments'));
        reply.code(500).send(err('internal', error instanceof Error ? error.message : String(error)));
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
      gitRoutes(api, backend);
      telegramRoutes(api, backend);
      await this.routes?.(api);
    }, { prefix: '/api' });
  }

  /** Build every route and listen. Once. */
  async listen(port: number, host = '0.0.0.0'): Promise<void> {
    await this.#build();
    await this.#app.listen({ port, host });
  }

  async close(): Promise<void> { await this.#app.close(); }
}
