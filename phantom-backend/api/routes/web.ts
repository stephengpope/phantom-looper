// The web surface — search and page fetch over Firecrawl, for the agents.
// The Firecrawl key is the `firecrawl_api_key` secret, read at the point of
// use (a key saved mid-session works on the next call); without one every
// call fails with a message that says where to put it. Results are
// Firecrawl's own, passed through — the HTTP status of a fetched page, the
// upstream error code and text of a failed one — never reinterpreted here.
//
// Fetched pages land in work/<session>/web/ — beside logs/, OUTSIDE repo/,
// where a push's `add -A` cannot commit them — and are returned as
// /workspace/web/<name>.md, the path the container (and so the read tool)
// sees. Same host-write pattern as the detached-bash logs in fs.ts.
import type { FastifyInstance } from 'fastify';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sessionDir } from '../../pool/paths.js';
import { getSession, touchSession } from '../../sessions.js';
import { resolveCredential } from '../../settings.js';
import { ok, err, type AppCtx } from '../app.js';
import { SESSION_HEADER } from './fs.js';

const TAG = { tags: ['web'] };

const apiBase = () => process.env.FIRECRAWL_API_BASE ?? 'https://api.firecrawl.dev';

const NO_KEY = 'no firecrawl key set — set firecrawl_api_key ' +
  '(PATCH /settings; in the TUI: /keys)';

/** One upstream call: 60s ceiling so a hung socket cannot hang the tool. */
async function firecrawl(key: string, route: string, body: unknown): Promise<Record<string, any>> {
  const r = await fetch(`${apiBase()}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return r.json() as Promise<Record<string, any>>;
}

/** A file name a URL deterministically maps to — the same page fetched twice
 *  lands in the same file. */
export function urlSlug(url: string): string {
  const s = url.replace(/^[a-z]+:\/\//i, '').replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').toLowerCase();
  return (s || 'page').slice(0, 60).replace(/-+$/, '');
}

type FetchEntry = Record<string, unknown>;

async function fetchOne(
  key: string, url: string, hostDir: string, taken: Set<string>,
): Promise<FetchEntry> {
  const scrape = (extra: Record<string, unknown>) => firecrawl(key, '/v2/scrape', {
    url, formats: ['markdown'], onlyMainContent: true, maxAge: 3_600_000, ...extra,
  });
  let r: Record<string, any>;
  try {
    r = await scrape({});
    // A page that came back unreadable — no markdown, or a bot wall
    // (403/429) — gets ONE more try through Firecrawl's enhanced proxy,
    // uncached. A hard failure (DNS, timeout) is not retried: the proxy
    // cannot help and the attempt costs seconds.
    const blocked = (x: Record<string, any>) => x.success &&
      (!String(x.data?.markdown ?? '').trim() || [403, 429].includes(x.data?.metadata?.statusCode));
    if (blocked(r)) r = await scrape({ proxy: 'enhanced', waitFor: 3000, maxAge: 0 });
  } catch (e) {
    return { url, error_code: 'request_failed', error: (e as Error).message };
  }
  if (!r.success) {
    return { url, error_code: String(r.code ?? 'scrape_failed'), error: String(r.error ?? 'scrape failed') };
  }
  const markdown = String(r.data?.markdown ?? '');
  const meta = (r.data?.metadata ?? {}) as Record<string, unknown>;
  if (!markdown.trim()) {
    return { url, error_code: 'empty_content',
      error: 'the page returned no readable content (retried through the enhanced proxy)',
      ...(meta.statusCode !== undefined ? { status_code: meta.statusCode } : {}) };
  }
  // Unique name within this call — two URLs may slug identically.
  let name = urlSlug(url); let n = 2;
  while (taken.has(name)) name = `${urlSlug(url)}-${n++}`;
  taken.add(name);
  await fsp.writeFile(path.join(hostDir, `${name}.md`), markdown);
  return {
    url,
    ...(meta.statusCode !== undefined ? { status_code: meta.statusCode } : {}),
    path: `/workspace/web/${name}.md`,
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    bytes: Buffer.byteLength(markdown),
  };
}

export function webRoutes(app: FastifyInstance, ctx: AppCtx) {
  app.post<{ Body: {
    query: string; limit?: number; tbs?: string;
    categories?: string[]; includeDomains?: string[]; excludeDomains?: string[];
  } }>('/web/search', {
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
    const key = await resolveCredential(ctx.db, ctx.encryptionKey, 'firecrawl_api_key');
    if (!key) return reply.code(400).send(err('credential_required', NO_KEY));
    // A filter left out is left out upstream — Firecrawl's defaults, not ours.
    const b = req.body;
    let r: Record<string, any>;
    try {
      r = await firecrawl(key, '/v2/search', {
        query: b.query, limit: b.limit ?? 5,
        ...(b.tbs !== undefined ? { tbs: b.tbs } : {}),
        ...(b.categories !== undefined ? { categories: b.categories } : {}),
        ...(b.includeDomains !== undefined ? { includeDomains: b.includeDomains } : {}),
        ...(b.excludeDomains !== undefined ? { excludeDomains: b.excludeDomains } : {}),
      });
    } catch (e) {
      return reply.code(502).send(err('search_failed', (e as Error).message, true));
    }
    if (!r.success) {
      return reply.code(502).send(err(String(r.code ?? 'search_failed'), String(r.error ?? 'search failed'), true));
    }
    const web = (r.data?.web ?? []) as Array<Record<string, unknown>>;
    // Snippets are usually ~150 chars but Firecrawl sometimes inlines a page
    // of markdown there — clipped, ten results stay a snippet list.
    return ok(web.map((w) => ({
      title: String(w.title ?? ''), url: String(w.url ?? ''),
      snippet: String(w.description ?? '').slice(0, 300),
      // Present when the search was category-filtered — which bucket this hit.
      ...(w.category !== undefined ? { category: String(w.category) } : {}),
    })));
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
    const sessionId = String(req.headers[SESSION_HEADER] ?? '');
    if (!sessionId) return reply.code(400).send(err('session_not_found', `missing ${SESSION_HEADER} header`));
    const session = await getSession(ctx.db, sessionId);
    if (!session) return reply.code(404).send(err('session_not_found', sessionId));
    if (session.status !== 'active') return reply.code(410).send(err('session_destroyed', `session is ${session.status}`));
    const key = await resolveCredential(ctx.db, ctx.encryptionKey, 'firecrawl_api_key');
    if (!key) return reply.code(400).send(err('credential_required', NO_KEY));
    void touchSession(ctx.db, sessionId);

    const hostDir = path.join(sessionDir(ctx.paths, session.folderId ?? session.id), 'web');
    await fsp.mkdir(hostDir, { recursive: true });
    const taken = new Set<string>();
    // In input order; fetched in parallel — the slug set is claimed
    // synchronously per entry inside fetchOne before any await on the write.
    return ok(await Promise.all(req.body.urls.map((u) => fetchOne(key, u, hostDir, taken))));
  });
}
