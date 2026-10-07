// The API's own documentation: an OpenAPI spec generated from every route's
// schema — the summary, description and shapes each one already carries —
// and the interactive page over it (@fastify/swagger + swagger-ui, as
// phantom-fs had). /docs and /docs/json.
//
// Off unless `api_docs_enabled` is on (read per request: no restart), and
// then behind the console's login — `console_admin` and the server's API
// key, which a browser asks for. Off, or the wrong login, it looks like
// nothing is there. The docs hold no data, but they are a map of the whole
// API, so they are the key holder's.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Settings } from '../storage/Settings.js';
import { timingSafeEqualStr } from '../lib/crypto.js';
import { DB_UI_USER, parseBasic } from './routes/dbUi.js';

export const DOCS_PREFIX = '/docs';

/** Collect every route as it is registered — call BEFORE any route. */
export async function collectDocs(app: FastifyInstance, version: string): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: { title: 'phantom-backend API', version,
        description: 'Every /api route takes the server key (`Authorization: Bearer <API_KEY>`), or a user: their sign-in token, or their API key (`x-api-key`). ' +
          'A user reaches only their own organization\'s data, and anything else answers `403 access denied`. /app routes are the app\'s own.' },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } } },
      security: [{ bearer: [] }, { apiKey: [] }],
    },
    // Not this API's to describe: the console's proxy, and sign-in (Better Auth answers it whole).
    transform: ({ schema, url }) => ({ schema: { ...schema, ...(url.startsWith('/db') || url.startsWith('/api/auth') ? { hide: true } : {}) }, url }),
  });
}

/** The page and the spec, behind the setting and the console's login. */
export async function serveDocs(app: FastifyInstance, settings: Settings, apiKey: string): Promise<void> {
  const gate = async (req: FastifyRequest, reply: FastifyReply) => {
    if (await settings.resolve('api_docs_enabled') !== true) return reply.code(404).send();
    const login = parseBasic(req.headers.authorization);
    if (!login || login.user !== DB_UI_USER || !timingSafeEqualStr(login.pass, apiKey)) {
      reply.header('www-authenticate', `Basic realm="phantom-backend API docs: user ${DB_UI_USER}, password: this server's API key", charset="UTF-8"`);
      return reply.code(401).send();
    }
  };
  await app.register(async (scope) => {
    scope.addHook('onRequest', gate);
    await scope.register(swaggerUi, { routePrefix: DOCS_PREFIX });
  });
}
