// GitHub REST calls that are not git: creating a repository. Ported from
// Shockwave's createRepo (src/main/sync.ts), with org support and the same
// deliberate error mapping — repo creation needs a wider token scope than
// read/write on existing repos (fine-grained: Administration:Write; classic:
// `repo`), and that specific failure must say so.
const apiBase = () => process.env.GITHUB_API_BASE ?? 'https://api.github.com';

const headers = (pat: string) => ({
  authorization: `Bearer ${pat}`,
  accept: 'application/vnd.github+json',
  'content-type': 'application/json',
  'user-agent': 'phantom-looper',
});

export type WhoamiResult =
  | { ok: true; login: string }
  | { ok: false; code: 'credential_invalid' | 'upstream_unreachable' | 'error'; message: string };

/** The token's own account — the owner a bare repo name creates under. */
export async function whoami(pat: string): Promise<WhoamiResult> {
  try {
    const me = await fetch(`${apiBase()}/user`, { headers: headers(pat) });
    if (me.status === 401) return { ok: false, code: 'credential_invalid', message: 'GitHub rejected the token' };
    if (!me.ok) return { ok: false, code: 'error', message: `GitHub returned ${me.status} for the token's account` };
    const login = String(((await me.json()) as { login?: string }).login ?? '');
    if (!login) return { ok: false, code: 'error', message: 'GitHub returned no login for the token' };
    return { ok: true, login };
  } catch (e) {
    return { ok: false, code: 'upstream_unreachable', message: `could not reach GitHub: ${(e as Error).message}` };
  }
}

export type CreateRepoResult =
  | { ok: true; cloneUrl: string; htmlUrl: string; fullName: string }
  | { ok: false; code: 'already_exists' | 'credential_insufficient' | 'credential_invalid' | 'upstream_unreachable' | 'error'; message: string };

/** Create `owner/name`. Under the authenticated user when `owner` is that
 *  user, otherwise under the org. auto_init=false: the caller pushes the first
 *  commit so the base branch carries the name WE chose, not the account's
 *  default-branch setting. */
export async function createRepo(
  pat: string, owner: string, name: string, opts: { private?: boolean; description?: string } = {},
): Promise<CreateRepoResult> {
  try {
    const me = await fetch(`${apiBase()}/user`, { headers: headers(pat) });
    if (me.status === 401) return { ok: false, code: 'credential_invalid', message: 'GitHub rejected the token' };
    const login = me.ok ? String(((await me.json()) as { login?: string }).login ?? '') : '';
    const path = login && login.toLowerCase() === owner.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`;
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'POST', headers: headers(pat),
      body: JSON.stringify({ name, private: opts.private ?? true, description: opts.description ?? '', auto_init: false }),
    });
    if (res.status === 201) {
      const j = (await res.json()) as { clone_url: string; html_url: string; full_name: string };
      return { ok: true, cloneUrl: j.clone_url, htmlUrl: j.html_url, fullName: j.full_name };
    }
    if (res.status === 422) {
      const j = (await res.json().catch(() => null)) as { errors?: { message?: string }[] } | null;
      return { ok: false, code: 'already_exists', message: j?.errors?.[0]?.message ?? 'repository name already exists or is invalid' };
    }
    if (res.status === 403) {
      const j = (await res.json().catch(() => null)) as { message?: string } | null;
      if (/rate limit/i.test(j?.message ?? '')) {
        return { ok: false, code: 'upstream_unreachable', message: 'GitHub rate limit hit — retry later' };
      }
      return { ok: false, code: 'credential_insufficient',
        message: 'token cannot create repositories here (fine-grained: Administration:Write on the account/org; classic: the `repo` scope' +
          (path.startsWith('/orgs/') ? '; org tokens also need the org to allow it' : '') + ')' };
    }
    if (res.status === 401) return { ok: false, code: 'credential_invalid', message: 'GitHub rejected the token' };
    if (res.status === 404) return { ok: false, code: 'error', message: `owner "${owner}" not found or token cannot see it` };
    return { ok: false, code: 'error', message: `GitHub returned ${res.status}` };
  } catch (e) {
    return { ok: false, code: 'upstream_unreachable', message: `could not reach GitHub: ${(e as Error).message}` };
  }
}

export interface GitHubRepo {
  owner: string; name: string; private: boolean; defaultBranch: string;
  /** ISO time of the last push — what the list is sorted by, newest first. */
  pushedAt: string | null;
}
export type ListReposResult =
  | { ok: true; repos: GitHubRepo[] }
  | { ok: false; code: 'credential_invalid' | 'upstream_unreachable' | 'error'; message: string };

/** Every repository the token can see — owned, collaborated on, or through an
 *  org — newest push first. Paged at GitHub's maximum; the page cap bounds the
 *  call for an account with thousands, and a short page is the end. */
export async function listRepos(pat: string, maxPages = 10): Promise<ListReposResult> {
  const perPage = 100;
  const repos: GitHubRepo[] = [];
  try {
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetch(`${apiBase()}/user/repos?per_page=${perPage}&page=${page}&sort=pushed` +
        '&affiliation=owner,collaborator,organization_member', { headers: headers(pat) });
      if (res.status === 401) return { ok: false, code: 'credential_invalid', message: 'GitHub rejected the token' };
      if (!res.ok) return { ok: false, code: 'error', message: `GitHub returned ${res.status} listing repositories` };
      const batch = (await res.json()) as {
        name: string; owner?: { login?: string }; private?: boolean; default_branch?: string; pushed_at?: string | null;
      }[];
      if (!Array.isArray(batch) || !batch.length) break;
      for (const r of batch) {
        repos.push({ owner: String(r.owner?.login ?? ''), name: r.name, private: !!r.private,
          defaultBranch: r.default_branch ?? 'main', pushedAt: r.pushed_at ?? null });
      }
      if (batch.length < perPage) break;
    }
    return { ok: true, repos };
  } catch (e) {
    return { ok: false, code: 'upstream_unreachable', message: `could not reach GitHub: ${(e as Error).message}` };
  }
}
