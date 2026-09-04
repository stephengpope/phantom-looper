// PURE git-remote URL policy — no child_process, no fs, so tests exercise it
// directly. Exists because of one specific bug class: a PAT embedded in a
// remote URL gets persisted into .git/config by `git clone` and `git remote
// set-url`, and the working copy belongs to the agent — `git remote -v` would
// hand the token over. Auth goes through a credential helper instead (git.ts);
// this builds the plain URL and hasEmbeddedCredentials pins the property.

/** The canonical remote URL for a GitHub repo. NEVER carries credentials. */
export function remoteUrl(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}.git`;
}

/** True if a URL carries credentials in its authority (user:pass@host). Only
 *  the authority counts — a path or query may legitimately contain '@'. */
export function hasEmbeddedCredentials(url: string): boolean {
  if (typeof url !== 'string') return false;
  const afterScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = afterScheme.split(/[/?#]/)[0];
  return authority.includes('@');
}

/** Parse owner/name out of a GitHub URL. Throws on anything else — multi-host
 *  support is a backend concern, not a parsing loophole. */
export function parseGitHubUrl(url: string): { owner: string; name: string } {
  if (hasEmbeddedCredentials(url)) throw new Error('repo URL must not embed credentials');
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error('repo URL must look like https://github.com/{owner}/{name}');
  return { owner: m[1], name: m[2] };
}

/** A repo reference the way a person types one: a full GitHub URL,
 *  `owner/name`, or a bare `name` (no owner — only creation can supply one,
 *  from the token's account). Throws on anything else. */
export function parseRepoRef(ref: string): { owner?: string; name: string } {
  const clean = ref.trim();
  // Anything URL-shaped (a scheme, or an @ that could carry credentials)
  // goes through the strict parser and its rejections.
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.includes('@')) return parseGitHubUrl(clean);
  const m = clean.match(/^(?:([A-Za-z0-9][A-Za-z0-9-]*)\/)?([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!m) throw new Error('give a GitHub URL, owner/name, or a repo name');
  return m[1] ? { owner: m[1], name: m[2] } : { name: m[2] };
}
