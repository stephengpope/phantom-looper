// The web — search and page fetch over Firecrawl, for the agents. The
// Firecrawl key is the `firecrawl_api_key` secret, read at the point of use
// (a key saved mid-session works on the next call); without one every call
// fails with a message that says where to put it. Results are Firecrawl's
// own, passed through — the HTTP status of a fetched page, the upstream
// error code and text of a failed one — never reinterpreted here. The one
// implementation behind the /web routes and the web_* tools.
//
// Fetched pages land in work/<session>/web/ — beside logs/, OUTSIDE repo/,
// where a push's `add -A` cannot commit them — and are returned as
// /workspace/web/<name>.md, the path the container (and so the read tool)
// sees. Same host-write pattern as the detached-bash logs in fs.ts.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sessionDir } from 'phantom-backend-sdk';
import type { AppCtx } from './api/app.js';
import { ToolError } from './tools/envelope.js';

export interface SearchBody {
  query: string; limit?: number; tbs?: string;
  categories?: string[]; includeDomains?: string[]; excludeDomains?: string[];
}

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

async function keyOf(ctx: AppCtx): Promise<string> {
  const key = await ctx.settings.credential('firecrawl_api_key');
  if (!key) throw new ToolError('credential_required', NO_KEY);
  return key;
}

/** Keyword search: title, url and snippet per result — no page content. A
 *  filter left out is left out upstream — Firecrawl's defaults, not ours.
 *  Throws ToolError: credential_required, search_failed (retryable). */
export async function webSearch(ctx: AppCtx, b: SearchBody): Promise<Array<Record<string, unknown>>> {
  const key = await keyOf(ctx);
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
    throw new ToolError('search_failed', (e as Error).message, true);
  }
  if (!r.success) throw new ToolError(String(r.code ?? 'search_failed'), String(r.error ?? 'search failed'), true);
  const web = (r.data?.web ?? []) as Array<Record<string, unknown>>;
  // Snippets are usually ~150 chars but Firecrawl sometimes inlines a page
  // of markdown there — clipped, ten results stay a snippet list.
  return web.map((hit) => ({
    title: String(hit.title ?? ''), url: String(hit.url ?? ''),
    snippet: String(hit.description ?? '').slice(0, 300),
    // Present when the search was category-filtered — which bucket this hit.
    ...(hit.category !== undefined ? { category: String(hit.category) } : {}),
  }));
}

/** Scrape each URL (in parallel), write the markdown under the session's
 *  work directory and answer the /workspace/web/ path per URL. A failed URL
 *  is an error entry; the call itself succeeds. */
export async function webFetch(ctx: AppCtx, workspaceId: string, urls: string[]): Promise<FetchEntry[]> {
  const key = await keyOf(ctx);
  const hostDir = path.join(sessionDir(ctx.paths, workspaceId), 'web');
  await fsp.mkdir(hostDir, { recursive: true });
  const taken = new Set<string>();
  // In input order; fetched in parallel — the slug set is claimed
  // synchronously per entry inside fetchOne before any await on the write.
  return Promise.all(urls.map((u) => fetchOne(key, u, hostDir, taken)));
}
