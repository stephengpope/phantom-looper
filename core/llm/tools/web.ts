/**
 * The WEB kit — `web_search`, `web_fetch`. Needs: a phantom-backend and a
 * session (fetched pages land in that session's /workspace/web/, where the
 * read tool can open them). Thin clients on the /web routes — the Firecrawl
 * key lives on the server as the `firecrawl_api_key` secret, and a call
 * without one fails with the message that says where to put it.
 */
import { tool, type Tool } from 'ai';
import { pickKit, type KitPick } from './presets.js';
import { z } from 'zod';

export interface WebToolsConfig {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
  /** Preset or explicit names; nothing in this kit mutates the repo, so
   *  `readonly` keeps both tools. */
  pick?: KitPick;
  fetch?: typeof fetch;
}

const SESSION_HEADER = 'x-phantom-looper-session';

export function webTools(cfg: WebToolsConfig): Record<string, Tool> {
  return pickKit(buildWebTools(cfg), [], cfg.pick);
}

function buildWebTools(cfg: WebToolsConfig): Record<string, Tool> {
  const f = cfg.fetch ?? fetch;
  // signal: esc aborts the fetch instead of waiting out a slow crawl — the
  // SDK holds the whole turn until a tool's promise settles.
  const api = async (p: string, body: unknown, signal?: AbortSignal): Promise<unknown> => {
    const r = await f(`${cfg.baseUrl}${p}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        [SESSION_HEADER]: cfg.sessionId,
      },
      body: JSON.stringify(body),
      signal,
    });
    return r.json();
  };

  return {
    web_search: tool({
      description: 'Search the web. Returns titles, URLs, and short snippets — often enough ' +
        'to answer a quick question on their own. To read a full page, pass its URL to web_fetch. ' +
        'Every filter is optional; leave them all out for a plain search. Use tbs when recency ' +
        'matters (docs and news go stale), categories to search only code, papers, or PDFs.',
      inputSchema: z.object({
        query: z.string().max(500).describe('the search query — specific multi-word queries beat vague ones'),
        limit: z.number().int().min(1).max(25).optional().describe('how many results (default 5, max 25)'),
        tbs: z.string().max(64).optional().describe('date filter: "qdr:h" | "qdr:d" | "qdr:w" | ' +
          '"qdr:m" | "qdr:y" = past hour/day/week/month/year; ' +
          '"cdr:1,cd_min:MM/DD/YYYY,cd_max:MM/DD/YYYY" = exact range; prefix "sbd:1," to sort ' +
          'newest first (e.g. "sbd:1,qdr:w")'),
        categories: z.array(z.enum(['github', 'research', 'pdf', 'developer'])).min(1).max(3)
          .optional().describe('only this kind of result: "github" = repos and code, ' +
            '"research" = papers, "pdf" = PDF documents, "developer" = developer docs ' +
            '("developer" cannot combine with the others)'),
        includeDomains: z.array(z.string()).min(1).max(20).optional()
          .describe('results from these domains only (e.g. ["github.com"]) — not combinable with excludeDomains'),
        excludeDomains: z.array(z.string()).min(1).max(20).optional()
          .describe('drop results from these domains'),
      }),
      execute: async (args, opts) => api('/web/search', args, opts?.abortSignal),
    }),

    web_fetch: tool({
      description: 'Fetch web pages as markdown (JavaScript rendered). Pass all URLs in one ' +
        'call — they fetch in parallel, so extra URLs cost almost no extra time. Each page is ' +
        'saved to a file; read the file to see its content. A URL that fails reports its error ' +
        'in place — the others still come back.',
      inputSchema: z.object({
        urls: z.array(z.string()).min(1).max(20)
          .describe('the pages to fetch — always an array, even for one URL'),
      }),
      execute: async (args, opts) => api('/web/fetch', args, opts?.abortSignal),
    }),
  };
}
