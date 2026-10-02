// Web — search and page fetch over Firecrawl for the agents; fetched pages
// land in the workspace's /workspace/web/ where `read` opens them. Stub.
export interface SearchQuery { query: string; limit?: number; categories?: string[]; tbs?: string; includeDomains?: string[]; excludeDomains?: string[] }
export interface SearchHit { title: string; url: string; snippet: string; category?: string }
export interface FetchedPage { url: string; path: string; title?: string; bytes: number; status: number }

export class Web {
  async search(projectId: string, query: SearchQuery): Promise<SearchHit[]> { throw stub(); }
  async fetchPages(projectId: string, workspaceId: string, urls: string[]): Promise<FetchedPage[]> { throw stub(); }
}
const stub = () => new Error('stub');
