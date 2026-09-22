// The database console at /db — CloudBeaver, on this server's own address,
// behind this server's own key.
//
// Gate: `db_ui_enabled` setting (read per request, flips without restart).
// Auth: HTTP Basic (phantom_admin + the API key) — a browser cannot send a
// bearer token by typing a URL, so this is the one path that speaks Basic.
// Past that the API injects X-User/X-Team and CloudBeaver — running with
// reverseProxy as its only auth provider — auto-creates the admin account.
// No second password exists anywhere.
//
// First contact bootstraps CloudBeaver: finish its setup wizard and preload
// the Postgres connection, both over its GraphQL API. Idempotent.
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import proxy from '@fastify/http-proxy';
import { timingSafeEqualStr } from '../../crypto.js';
import type { Settings } from '../../settings.js';
import { logger, errStr } from '../../log.js';

const log = logger('db-ui');

/** The path the console lives at, on this server's own address. */
export const DB_UI_PREFIX = '/db';

/** The user CloudBeaver knows you as. Auto-created on first request. */
const DB_UI_USER = 'phantom_admin';

/** CloudBeaver's built-in admin team. Sent as X-Team so the auto-created
 *  user lands with full rights rather than as a viewer. */
const DB_UI_TEAM = 'admin';

// ── helpers ──────────────────────────────────────────────────────────────────

/** `Authorization: Basic` → {user, pass}, or null. */
function parseBasic(header: string | undefined): { user: string; pass: string } | null {
  if (!header?.startsWith('Basic ')) return null;
  const raw = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const i = raw.indexOf(':');
  if (i < 0) return null;
  return { user: raw.slice(0, i), pass: raw.slice(i + 1) };
}

// ── CloudBeaver GraphQL bootstrap ────────────────────────────────────────────

/** One GraphQL call against CloudBeaver, with a cookie jar.
 *  Several of its "mutations" are declared under `extend type Query` — so the
 *  operation keyword is the caller's to pick (configureServer must be `query`
 *  or it answers FieldUndefined). */
async function gql(
  base: string, op: string, jar: { cookie?: string }, headers: Record<string, string> = {},
): Promise<any> {
  const r = await fetch(`${base}${DB_UI_PREFIX}/api/gql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(jar.cookie ? { cookie: jar.cookie } : {}),
      ...headers,
    },
    body: op,
    signal: AbortSignal.timeout(30_000),
  });
  const set = r.headers.get('set-cookie');
  if (set) jar.cookie = set.split(';')[0];
  const body = await r.json() as { data?: any; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(body.errors.map(e => e.message).join('; '));
  return body.data;
}

const q = (query: string, variables?: unknown) => JSON.stringify({ query, variables });

/** postgres://user:pass@host:port/db → the fields CloudBeaver wants. */
function connectionFromDsn(dsn: string) {
  const u = new URL(dsn);
  return {
    name: u.pathname.replace(/^\//, '') || 'postgres',
    driverId: 'postgresql:postgres-jdbc',
    host: u.hostname,
    port: u.port || '5432',
    databaseName: u.pathname.replace(/^\//, ''),
    userName: decodeURIComponent(u.username),
    userPassword: decodeURIComponent(u.password),
    saveCredentials: true,
    // Show every database on the server (including agent workspace_* dbs),
    // not just the one named in the connection string.
    providerProperties: { '@dbeaver-show-non-default-db@': 'true' },
  };
}

/** Take a freshly-booted CloudBeaver from its setup wizard to a ready
 *  console and preload the connection. Idempotent. */
async function bootstrap(base: string, dsn: string | undefined): Promise<void> {
  const jar: { cookie?: string } = {};
  await gql(base, q('mutation{openSession{valid}}'), jar);

  const { serverConfig } = await gql(base, q('{serverConfig{configurationMode}}'), jar);
  if (serverConfig.configurationMode) {
    await gql(base, q(
      'query($c:ServerConfigInput!){configureServer(configuration:$c)}',
      {
        c: {
          serverName: 'phantom-looper',
          anonymousAccessEnabled: false,
          customConnectionsEnabled: true,
          adminCredentialsSaveEnabled: true,
          publicCredentialsSaveEnabled: true,
          enabledAuthProviders: ['reverseProxy'],
        },
      },
    ), jar);
    log.info('database console configured');
  }

  if (!dsn) return;
  // Past the wizard the console is authenticated by header.
  const admin = { 'x-user': DB_UI_USER, 'x-team': DB_UI_TEAM };
  const jar2: { cookie?: string } = {};
  await gql(base, q('mutation{openSession{valid}}'), jar2, admin);

  const conn = connectionFromDsn(dsn);
  const { connections } = await gql(base, q(
    'query($p:ID!){connections:userConnections(projectId:$p){id name}}',
    { p: 'g_GlobalConfiguration' },
  ), jar2, admin).catch(() => ({ connections: [] }));
  const existing = (connections ?? []).find((c: { name: string }) => c.name === conn.name) as
    { id: string; name: string } | undefined;
  if (existing) {
    await gql(base, q(
      'mutation($id:ID!,$p:ID!){deleteConnection(id:$id,projectId:$p)}',
      { id: existing.id, p: 'g_GlobalConfiguration' },
    ), jar2, admin).catch(() => {});
  }

  await gql(base, q(
    'mutation($p:ID!,$c:ConnectionConfig!){createConnection(projectId:$p,config:$c){id name}}',
    { p: 'g_GlobalConfiguration', c: conn },
  ), jar2, admin);
  log.info({ connection: conn.name }, 'database console connection preloaded');
}

/** One bootstrap per process, retried on failure. */
let bootstrapped: Promise<void> | null = null;
function ensureBootstrapped(base: string): Promise<void> {
  if (!bootstrapped) {
    bootstrapped = bootstrap(base, process.env.DB_UI_DSN).catch((e) => {
      bootstrapped = null;
      throw e;
    });
  }
  return bootstrapped;
}

// ── route registration ───────────────────────────────────────────────────────

export function dbUiRoutes(app: FastifyInstance, settings: Settings, apiKey: string) {
  const dbUiUrl = () => process.env.DB_UI_URL;

  const gate = async (req: FastifyRequest, reply: FastifyReply) => {
    const base = dbUiUrl();
    if (!base) {
      return reply.code(503).send({ ok: false, error: { code: 'db_ui_unavailable',
        message: 'no database console in this stack (DB_UI_URL unset)' } });
    }
    if (!await settings.resolve('db_ui_enabled')) {
      // Looks like the path does not exist — reveals nothing.
      return reply.code(404).send();
    }

    const cred = parseBasic(req.headers.authorization);
    if (!cred || cred.user !== DB_UI_USER || !timingSafeEqualStr(cred.pass, apiKey)) {
      // ASCII only — Node rejects non-ASCII in header values.
      reply.header('www-authenticate',
        `Basic realm="phantom-looper: user ${DB_UI_USER}, password: this server's API key", charset="UTF-8"`);
      return reply.code(401).send();
    }

    try {
      await ensureBootstrapped(base);
    } catch (e) {
      log.error({ err: errStr(e) }, 'database console bootstrap failed');
      return reply.code(503).send({ ok: false, error: { code: 'db_ui_unavailable',
        message: `the database console is not ready: ${errStr(e)}`, retryable: true } });
    }
  };

  // The gate is an onRequest hook in the proxy's own encapsulated scope —
  // NOT the proxy's preHandler. A preHandler that answers the request itself
  // still leaves the proxy to run, turning the reply into a 500.
  app.register(async (scope) => {
    scope.addHook('onRequest', gate);
    scope.register(proxy, {
      upstream: dbUiUrl() ?? 'http://db-ui.invalid',
      prefix: DB_UI_PREFIX,
      // CloudBeaver is mounted at /db (CLOUDBEAVER_ROOT_URI), so the prefix
      // is passed through — every asset and API path it emits already carries it.
      rewritePrefix: DB_UI_PREFIX,
      websocket: false,
      replyOptions: {
        rewriteRequestHeaders: (_req, headers) => {
          // LOWERCASE names only. Node lowercases incoming headers; setting
          // mixed-case creates duplicates that arrive concatenated.
          const out = { ...headers };
          out['x-user'] = DB_UI_USER;
          out['x-team'] = DB_UI_TEAM;
          delete out.authorization;
          return out;
        },
      },
    });
  });
}

// ── container lifecycle ──────────────────────────────────────────────────────

const CB_SERVICE_LABEL = 'com.docker.compose.service=cloudbeaver';

/** Find the CloudBeaver container (running or stopped). */
async function findContainer(docker: import('dockerode')): Promise<import('dockerode').Container | null> {
  const list = await docker.listContainers({ all: true, filters: { label: [CB_SERVICE_LABEL] } });
  return list.length ? docker.getContainer(list[0].Id) : null;
}

/** Start or stop the CloudBeaver container to match the setting. */
export async function reconcileDbUi(docker: import('dockerode') | undefined, settings: Settings): Promise<void> {
  if (!docker) return;
  const enabled = await settings.resolve('db_ui_enabled');
  const container = await findContainer(docker).catch(() => null);
  if (!container) return;
  try {
    const info = await container.inspect();
    if (enabled && !info.State.Running) {
      await container.start();
      log.info('database console container started');
    } else if (!enabled && info.State.Running) {
      await container.stop();
      log.info('database console container stopped');
    }
  } catch (e) {
    log.warn({ err: errStr(e) }, 'database console container reconciliation failed');
  }
}
