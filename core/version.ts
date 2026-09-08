// Version checking — shared by the cli and the server. One GET of the latest
// published GitHub release, and a semver compare. Nothing here touches the
// filesystem, the database, or any UI — pure functions plus one fetch.

export const REPO = 'stephengpope/phantom-looper';

/** vX.Y.Z (or X.Y.Z) → [X, Y, Z]; anything else — 'dev', prereleases — null. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is `mine` behind `theirs`? Unparseable on either side — 'dev', a
 *  prerelease — is never behind: only two release builds compare. */
export function isBehind(mine: string, theirs: string): boolean {
  const a = parseVersion(mine), b = parseVersion(theirs);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

/** 'v0.1.3' → '0.1.3'. */
export function bare(v: string): string { return v.replace(/^v/, ''); }

/** The latest PUBLISHED release tag, or null when there is none / no network.
 *  Never throws and never blocks long — call sites fire it in the background. */
export async function checkLatest(fetchFn: typeof fetch = fetch, repo = REPO): Promise<string | null> {
  try {
    const r = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j = await r.json() as { tag_name?: string };
    return j.tag_name ?? null;
  } catch { return null; }
}
