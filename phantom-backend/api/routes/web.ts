// The web surface — thin routes over web.ts (the web_* tools run the same
// code).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ok, err, type AppCtx } from '../app.js';
import { SESSION_HEADER, toolSession } from '../sessionHeader.js';
import { ToolError } from '../../tools/envelope.js';
import { webFetch, webSearch, type SearchBody } from '../../web.js';

const STATUS: Record<string, number> = {
  session_not_found: 404, session_destroyed: 410, no_workspace: 400, credential_required: 400, search_failed: 502,
};

const TAG = { tags: ['web'] };

export function webRoutes(app: FastifyInstance, ctx: AppCtx) {
  const handle = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ToolError) return reply.code(STATUS[e.code] ?? 502).send(err(e.code, e.message, e.retryable));
    throw e;
  };

  app.post<{ Body: SearchBody }>('/web/search', {
    schema: {
      ...TAG, summary: 'Search the web',
      description: 'Keyword search over Firecrawl. Returns title, url and snippet per result — no page content; POST /web/fetch reads a page. Optional filters (tbs, categories, includeDomains/excludeDomains) are Firecrawl\'s own, forwarded only when given. Needs the firecrawl_api_key secret.',
      body: {
        type: 'object', required: ['query'], additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 500 },
          limit: { type: 'integer', minimum: 1, maximum: 25, default: 5 },
          tbs: { type: 'string', minLength: 1, maxLength: 64 },
          categories: { type: 'array', minItems: 1, maxItems: 3,
            items: { type: 'string', enum: ['github', 'research', 'pdf', 'developer'] } },
          includeDomains: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1 } },
          excludeDomains: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1 } },
        },
      },
    },
  }, async (req, reply) => {
    try { return ok(await webSearch(ctx, req.body)); }
    catch (e) { return handle(reply, e); }
  });

  app.post<{ Body: { urls: string[] } }>('/web/fetch', {
    schema: {
      ...TAG, summary: 'Fetch web pages as markdown',
      description: 'Scrapes each URL (in parallel) via Firecrawl, writes the markdown under the session\'s work directory (outside the repo — never committed) and returns the /workspace/web/ path per URL. A failed URL is an error entry; the call itself succeeds. Needs the firecrawl_api_key secret.',
      headers: {
        type: 'object',
        properties: { [SESSION_HEADER]: { type: 'string', description: 'Session id (ULID). Required — the files land in this session\'s directory.' } },
      },
      body: {
        type: 'object', required: ['urls'], additionalProperties: false,
        properties: {
          urls: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1 } },
        },
      },
    },
  }, async (req, reply) => {
    try {
      // The one gate (sessionHeader.ts): the session named, its files on
      // disk, THE workspace its tools open — and the checkout touched.
      const { workspaceId } = await toolSession(ctx.sessions, req.headers);
      return ok(await webFetch(ctx, workspaceId, req.body.urls));
    } catch (e) { return handle(reply, e); }
  });
}
