// GitHub — the REST calls that are not git: who the token is, create a
// repository, list repositories. Stub.
export interface GitHubRepo { owner: string; name: string; private: boolean; defaultBranch: string }
export class GitHub {
  async whoami(pat: string): Promise<{ login: string }> { throw stub(); }
  async createRepo(pat: string, name: string, options?: { org?: string; private?: boolean }): Promise<GitHubRepo> { throw stub(); }
  async listRepos(pat: string, maxPages?: number): Promise<GitHubRepo[]> { throw stub(); }
}
const stub = () => new Error('stub');
