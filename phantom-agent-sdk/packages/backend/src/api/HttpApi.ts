// HttpApi — the HTTP surface: Fastify, the envelope ({ok, data} /
// {ok:false, error:{code, message, retryable}}), and three prefixes that say
// who owns a route and who may call it (docs/multi-user.md):
//
//   /api/*       the SDK's routes; the phantom admin's bearer key on every one
//   /api/auth/*  Identity (Better Auth): sign-in, organizations, invitations,
//                keys — public, or the user's own token
//   /app/*       user space's routes (config.routes); no key here — the app
//                gates each with backend.identity.require
//
// The database console rides beside them at /db. Any request that lands
// outside these gets a bare 401 with no body — no envelope, no framework
// fingerprint, no confirmation that anything exists.
//
// summary/description/tags stay on every route — they are the API's
// in-source documentation; Fastify ignores them for validation.
declare module 'fastify' {
  interface FastifySchema { tags?: readonly string[]; summary?: string; description?: string }
}
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
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
import { mailRoutes } from './routes/mail.js';
import { mediaRoutes } from './routes/media.js';
import { identityRoutes } from './routes/identity.js';
import { IDENTITY_PATH, IdentityError } from '../identity/Identity.js';
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

const IDENTITY_STATUS: Record<IdentityError['code'], number> = { unauthorized: 401, disabled: 503, email_taken: 409 };

/** The envelope's answers for what Fastify raises: a route that is not
 *  there, a body that fails its schema, a caller Identity refuses. */
function envelopeHandlers(api: FastifyInstance): void {
  api.setNotFoundHandler((req, reply) => { reply.code(404).send(err('not_found', `no route ${req.method} ${req.url}`)); });
  api.setErrorHandler((error: unknown, _req, reply) => {
    const fastifyError = error as { validation?: unknown; message?: string };
    if (fastifyError.validation) return reply.code(400).send(err('invalid_args', fastifyError.message ?? 'invalid arguments'));
    if (error instanceof IdentityError) return reply.code(IDENTITY_STATUS[error.code]).send(err(error.code, error.message));
    reply.code(500).send(err('internal', error instanceof Error ? error.message : String(error)));
  });
}

export class HttpApi {
  readonly #app: FastifyInstance;

  constructor(private readonly backend: PhantomBackend, private readonly apiKey: string,
    /** User space's routes, registered under /app with no key check: the app gates them. */
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

    // /db: CloudBeaver, proxied. Basic auth (console_admin + the API key),
    // not bearer — a browser cannot send bearer by typing a URL.
    dbUiRoutes(app, backend.settings, this.apiKey);

    await app.register(async (api) => {
      // Any caller: every client SDK checks the version here before its first
      // call — a signed-in user's and an API key's as much as the phantom admin's.
      api.get('/health', { config: { caller: true }, schema: { tags: ['meta'], summary: 'Liveness',
        description: 'Any caller (the API key, a user\'s token or API key). Returns the running version, the backend SDK\'s version (`sdk_version` — the client SDK refuses a backend on another), plus what the app reports (config.health).' } },
      async (req) => {
        await backend.identity.require(req);
        return { ok: true, version: backend.version, sdk_version: SDK_VERSION, ...backend.healthExtras() };
      });

      api.addHook('onRequest', async (req, reply) => {
        // A route marked `caller: true` takes any caller Identity knows and
        // decides for itself (GET /identity/me).
        if (PUBLIC_PATHS.has(req.url) || (req.routeOptions.config as { caller?: boolean }).caller) return;
        const auth = String(req.headers.authorization ?? '');
        if (!timingSafeEqualStr(auth, `Bearer ${this.apiKey}`)) return reply.code(401).send();
      });
      // Unknown routes inside /api speak the envelope — the model may probe a tool name that does not exist.
      envelopeHandlers(api);

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
      mailRoutes(api, backend);
      mediaRoutes(api, backend);
      identityRoutes(api, backend);
    }, { prefix: '/api' });

    // A browser app on another origin (identity.trustedOrigins) may call
    // /api/auth and /app with its cookie: CORS with credentials on those two.
    const { trustedOrigins } = backend.identity;
    const browserOrigins = async (scope: FastifyInstance) => {
      if (trustedOrigins.length) await scope.register(cors, { origin: [...trustedOrigins], credentials: true });
    };

    // Identity's own routes: Better Auth answers them whole, no envelope.
    // Off, the prefix does not exist (the bare 401 above).
    if (backend.identity.enabled) {
      await app.register(async (identityScope) => {
        await browserOrigins(identityScope);
        identityScope.all('/*', (req, reply) => backend.identity.handler(req, reply));
      }, { prefix: IDENTITY_PATH });
    }

    // User space's routes, under the envelope, with no key check: the app
    // gates each with backend.identity.require.
    if (this.routes) {
      await app.register(async (appScope) => {
        await browserOrigins(appScope);
        envelopeHandlers(appScope);
        await this.routes!(appScope);
      }, { prefix: '/app' });
    }
  }

  /** Build every route and listen. Once. */
  async listen(port: number, host = '0.0.0.0'): Promise<void> {
    await this.#build();
    await this.#app.listen({ port, host });
  }

  async close(): Promise<void> { await this.#app.close(); }
}
