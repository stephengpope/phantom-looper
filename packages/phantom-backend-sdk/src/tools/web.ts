// The WEB tools — web_search, web_fetch, over web.ts. Fetched pages land in
// the session's /workspace/web/, where `read` opens them, so web_fetch needs
// a session with files; web_search does not.
import { webFetch, webSearch, type SearchBody } from '../runtime/Web.js';
import { ToolError } from './envelope.js';
import { obj, type OfferCtx, type ToolDef } from './def.js';

const hasFiles = ({ session }: OfferCtx) => Promise.resolve(!!session.workspaceId);

export const WEB_TOOLS: ToolDef[] = [
  {
    name: 'web_search',
    summary: 'Search the web.',
    description: 'Search the web. Returns titles, URLs, and short snippets — often enough ' +
      'to answer a quick question on their own. To read a full page, pass its URL to web_fetch. ' +
      'Every filter is optional; leave them all out for a plain search. Use tbs when recency ' +
      'matters (docs and news go stale), categories to search only code, papers, or PDFs.',
    input: obj({
      query: { type: 'string', maxLength: 500, description: 'the search query — specific multi-word queries beat vague ones' },
      limit: { type: 'integer', minimum: 1, maximum: 25, description: 'how many results (default 5, max 25)' },
      tbs: { type: 'string', maxLength: 64, description: 'date filter: "qdr:h" | "qdr:d" | "qdr:w" | ' +
        '"qdr:m" | "qdr:y" = past hour/day/week/month/year; ' +
        '"cdr:1,cd_min:MM/DD/YYYY,cd_max:MM/DD/YYYY" = exact range; prefix "sbd:1," to sort ' +
        'newest first (e.g. "sbd:1,qdr:w")' },
      categories: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['github', 'research', 'pdf', 'developer'] },
        description: 'only this kind of result: "github" = repos and code, ' +
          '"research" = papers, "pdf" = PDF documents, "developer" = developer docs ' +
          '("developer" cannot combine with the others)' },
      includeDomains: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' },
        description: 'results from these domains only (e.g. ["github.com"]) — not combinable with excludeDomains' },
      excludeDomains: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' },
        description: 'drop results from these domains' },
    }, ['query']),
    mutates: false, group: 'web',
    execute: (ctx, a) => webSearch(ctx.app, a as unknown as SearchBody),
  },
  {
    name: 'web_fetch',
    summary: 'Fetch web pages as markdown.',
    description: 'Fetch web pages as markdown (JavaScript rendered). Pass all URLs in one ' +
      'call — they fetch in parallel, so extra URLs cost almost no extra time. Each page is ' +
      'saved to a file; read the file to see its content. A URL that fails reports its error ' +
      'in place — the others still come back.',
    input: obj({
      urls: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' }, description: 'the pages to fetch — always an array, even for one URL' },
    }, ['urls']),
    mutates: false, group: 'web', offered: hasFiles,
    execute(ctx, a) {
      if (!ctx.session.workspaceId) throw new ToolError('no_workspace', 'this session has no files — nowhere to save a page');
      return webFetch(ctx.app, ctx.session.workspaceId, a.urls as string[]);
    },
  },
];
