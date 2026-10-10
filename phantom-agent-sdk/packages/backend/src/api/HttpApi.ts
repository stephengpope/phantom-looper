// HttpApi — the HTTP surface: Fastify, the envelope ({ok, data} /
// {ok:false, error:{code, message, retryable}}), and three prefixes that say
// who owns a route and who may call it:
//
//   /api/*       the SDK's routes: the service role key, or a user (sign-in
//                token or user API key)
//   /api/auth/*  Identity (Better Auth): sign-in, organizations, invitations,
//                keys — public, or the user's own token
//   /app/*       user space's routes (config.routes); anyone reaches them —
//                the app gates each with backend.identity.require
//
// THE front step, on /api and /app alike: who is
// calling, and who the work is for. A user's request — or the service role's
// naming one with x-phantom-organization / x-phantom-user — runs as that
// organization and user (lib/acting.ts): every query it makes is fenced by
// the row-level policies, and nothing else decides. The service role alone
// runs as itself and sees everything. A user gets one refusal for anything
// they may not reach — `403 access denied`, the same whether the thing is
// missing or not theirs — shaped here and nowhere else.
//
// The database console rides beside them at /db. Any request that lands
// outside these gets a bare 401 with no body — no envelope, no framework
// fingerprint, no confirmation that anything exists.
//
// summary/description/tags stay on every route — they are the API's
// in-source documentation; Fastify ignores them for validation.
declare module 'fastify' {
  interface FastifySchema { tags?: readonly string[]; summary?: string; description?: string }
  /** Set by the front step: who is calling (null = nobody). */
  interface FastifyRequest { caller: Caller | null }
  /** `serviceRole: true` — the service role's alone; a user gets access denied. */
  interface FastifyContextConfig { serviceRole?: boolean }
}
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import type { PhantomBackend } from '../PhantomBackend.js';
import type { RouteRegistrar } from '../doors.js';
import { settingsRoutes } from './routes/settings.js';
import { secretsRoutes } from './routes/secrets.js';
import { projectRoutes } from './routes/projects.js';
import { databaseRoutes } from './routes/database.js';
import { sessionRoutes } from './routes/sessions.js';
import { toolRoutes } from './routes/tools.js';
import { tasksRoutes } from './routes/tasks.js';
import { kanbanRoutes } from './routes/kanban.js';
import { presetRoutes } from './routes/presets.js';
import { cronRoutes } from './routes/crons.js';
import { dbUiRoutes } from './routes/dbUi.js';
import { gitRoutes } from './routes/git.js';
import { telegramRoutes } from './routes/telegram.js';
import { TELEGRAM_WEBHOOK_PATH } from '../telegram/webhookPath.js';
import { mailRoutes } from './routes/mail.js';
import { mediaRoutes } from './routes/media.js';
import { identityRoutes } from './routes/identity.js';
import { runnerRoutes } from './routes/runners.js';
import { systemRoutes } from './routes/system.js';
import { IDENTITY_PATH, IdentityError, type Caller } from '../identity/Identity.js';
import { actAs, type Acting } from '../lib/acting.js';
import { logger, errStr } from '../lib/log.js';
import { SDK_VERSION } from '../sdkVersion.js';
import { collectDocs, serveDocs } from './docs.js';

export function err(code: string, message: string, retryable = false, detail?: unknown) {
  return { ok: false as const, error: { code, message, retryable, ...(detail === undefined ? {} : { detail }) } };
}
export function ok<T>(data: T) {
  return { ok: true as const, data };
}

const log = logger('http');

/** The headers the service role names who it acts for with. */
export const ACTING_ORGANIZATION_HEADER = 'x-phantom-organization';
export const ACTING_USER_HEADER = 'x-phantom-user';

/** The one refusal a user ever gets. */
const ACCESS_DENIED = err('access_denied', 'access denied');

/** Postgres refusing a write the policies do not allow (insufficient_privilege). */
const isPolicyRefusal = (error: unknown) => {
  const failed = error as { code?: string; cause?: { code?: string } } | null;
  return (failed?.code ?? failed?.cause?.code) === '42501';
};

/** The one path the front step skips: the Telegram webhook, whose sender
 *  cannot carry our key and brings its own secret instead. */
const PUBLIC_PATHS = new Set([`/api${TELEGRAM_WEBHOOK_PATH}`]);

const IDENTITY_STATUS: Record<IdentityError['code'], number> = { unauthorized: 401, disabled: 503, email_taken: 409 };

/** The envelope's answers for what Fastify raises: a route that is not
 *  there, a body that fails its schema, a caller Identity refuses. */
function envelopeHandlers(api: FastifyInstance): void {
  api.setNotFoundHandler((req, reply) => { reply.code(404).send(err('not_found', `no route ${req.method} ${req.url}`)); });
  api.setErrorHandler((error: unknown, req, reply) => {
    const fastifyError = error as { validation?: unknown; message?: string };
    if (fastifyError.validation) return reply.code(400).send(err('invalid_args', fastifyError.message ?? 'invalid arguments'));
    if (error instanceof IdentityError) return reply.code(IDENTITY_STATUS[error.code]).send(err(error.code, error.message));
    if (isPolicyRefusal(error)) return reply.code(403).send(ACCESS_DENIED);
    // The detail is the log's: a 500 says nothing of the inside, whoever asked.
    log.error({ url: req.url, caller: req.caller?.type ?? 'nobody', err: errStr(error) }, 'request failed');
    reply.code(500).send(err('internal', 'internal error'));
  });
  // A user's not-found and forbidden are one answer: access denied.
  api.addHook('onSend', async (req, reply, payload) => {
    if (req.caller?.type !== 'user' || (reply.statusCode !== 404 && reply.statusCode !== 403)) return payload;
    reply.code(403).header('content-type', 'application/json; charset=utf-8');
    return JSON.stringify(ACCESS_DENIED);
  });
}

export class HttpApi {
  readonly #app: FastifyInstance;

  constructor(private readonly backend: PhantomBackend, private readonly serviceRoleKey: string,
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
    app.decorateRequest('caller', null);
    app.setNotFoundHandler((_req, reply) => { reply.code(401).send(); });
    app.setErrorHandler((_error, _req, reply) => { reply.code(401).send(); });

    // The docs collect every route registered after this; the page itself is served below.
    await collectDocs(app, backend.version);

    // /db: CloudBeaver, proxied. Basic auth (service_role + the service role
    // key), not bearer — a browser cannot send bearer by typing a URL.
    dbUiRoutes(app, backend.settings, this.serviceRoleKey);

    await app.register(async (api) => {
      // Any caller: every client SDK checks the version here before its first
      // call — a signed-in user's and a user key's as much as the service role's.
      api.get('/health', { schema: { tags: ['meta'], summary: 'Check the server is up',
        description: 'Answers with the server\'s version and the SDK version it runs. Any valid credential works. Clients call it first, to check they speak the same SDK version as the server.' } },
      async (req) => {
        await backend.identity.require(req);
        return { ok: true, version: backend.version, sdk_version: SDK_VERSION, ...backend.healthExtras() };
      });

      api.addHook('onRequest', this.#frontStep(true));
      // Unknown routes inside /api speak the envelope — the model may probe a tool name that does not exist.
      envelopeHandlers(api);

      settingsRoutes(api, backend);
      secretsRoutes(api, backend);
      projectRoutes(api, backend);
      databaseRoutes(api, backend);
      sessionRoutes(api, backend);
      toolRoutes(api, backend);
      tasksRoutes(api, backend);
      kanbanRoutes(api, backend);
      presetRoutes(api, backend);
      cronRoutes(api, backend);
      gitRoutes(api, backend);
      telegramRoutes(api, backend);
      mailRoutes(api, backend);
      mediaRoutes(api, backend);
      identityRoutes(api, backend);
      runnerRoutes(api, backend);
      systemRoutes(api, backend);
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
    // gates each with backend.identity.require. The line: /api serves what
    // the SDK builds, /app what the app builds. A route that reads straight
    // off the backend is the SDK's, and the SDK serves it under /api.
    if (this.routes) {
      await app.register(async (appScope) => {
        await browserOrigins(appScope);
        appScope.addHook('onRequest', this.#frontStep(false));
        envelopeHandlers(appScope);
        await this.routes!(appScope);
      }, { prefix: '/app' });
    }

    // The API's docs (/docs): off unless api_docs_enabled, then behind the console's login.
    await serveDocs(app, backend.settings, this.serviceRoleKey);
  }

  /** Who is calling, and who the work is for: a user acts for themselves in
   *  their organization; the service role acts for whoever its headers name,
   *  or for no one. 'invalid': the headers name an organization that is not
   *  there, or a user who is not its member. */
  async #who(req: FastifyRequest): Promise<{ caller: Caller; acting?: Acting } | null | 'invalid'> {
    const caller = await this.backend.identity.callerOf(req);
    if (!caller) return null;
    if (caller.type === 'user') return { caller, acting: { organizationId: caller.organization.id, userId: caller.user.id } };
    const header = (name: string) => { const value = req.headers[name]; return typeof value === 'string' && value ? value : undefined; };
    const organizationId = header(ACTING_ORGANIZATION_HEADER);
    const userId = header(ACTING_USER_HEADER);
    if (!organizationId && !userId) return { caller };
    if (!organizationId) return 'invalid';
    const acting = await this.backend.identity.actingFor(organizationId, userId);
    return acting ? { caller, acting } : 'invalid';
  }

  /** THE front step. `required`: nobody gets a bare 401 (/api); else the
   *  request goes on with no caller and the route decides (/app). The rest
   *  of the request — every hook, the handler, everything it awaits — runs
   *  inside `actAs` when the work is for someone. Callback style: the
   *  request's remaining lifecycle continues from inside `actAs`. */
  #frontStep(required: boolean) {
    return (req: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void) => {
      if (PUBLIC_PATHS.has(req.url)) { done(); return; }
      this.#who(req).then((who) => {
        if (who === 'invalid') {
          reply.code(400).send(err('invalid_acting', `${ACTING_ORGANIZATION_HEADER} must name an organization, and ${ACTING_USER_HEADER} a member of it`));
          return;
        }
        req.caller = who?.caller ?? null;
        if (!who) { if (required) reply.code(401).send(); else done(); return; }
        if (who.caller.type === 'user' && req.routeOptions.config?.serviceRole) { reply.code(403).send(ACCESS_DENIED); return; }
        if (who.acting) actAs(who.acting, () => done()); else done();
      }, (error: unknown) => done(error instanceof Error ? error : new Error(String(error))));
    };
  }

  /** Build every route and listen. Once. */
  async listen(port: number, host = '0.0.0.0'): Promise<void> {
    await this.#build();
    await this.#app.listen({ port, host });
  }

  async close(): Promise<void> { await this.#app.close(); }
}
