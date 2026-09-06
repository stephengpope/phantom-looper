// The model catalog: models.dev, held by THIS server for every client. The
// cli's /model picker, the wizard's model question and the "newest model"
// default all read it here, so there is one list and one notion of newest.
//
// Resolution, synchronous and never throwing (settings resolution calls it on
// every read):
//   1. the in-memory copy, under an hour old
//   2. the last good copy, whatever its age — a fetch failure never blanks it
//   3. the snapshot beside this file (models-snapshot.json)
// A stale or missing memory copy kicks ONE background refresh; the caller is
// answered from whatever is there right now. Offline is a normal state.
//
// The snapshot is written by scripts/models-snapshot.ts: the image build runs
// it so every release ships current (Dockerfile), and `npm run models:snapshot`
// refreshes the committed one a source run reads. It fails loudly when
// models.dev does not answer — a release must not ship a stale list by
// accident. MODELS_DEV_API_BASE is the test seam, like GITHUB_API_BASE.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const apiBase = () => process.env.MODELS_DEV_API_BASE ?? 'https://models.dev';
/** Beside this file: phantom-backend/ from source, dist/phantom-backend/ in the
 *  image (the build writes a fresh one there). A dist run from a checkout has
 *  no copy beside it and reads the committed one. */
const SNAPSHOT_PATH = join(import.meta.dirname, 'models-snapshot.json');
const SNAPSHOT_FALLBACK = join(import.meta.dirname, '..', '..', 'phantom-backend', 'models-snapshot.json');
const TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

/** Only providers whose native ids the agents call directly. openai-compatible
 *  is an arbitrary endpoint with no registry to list: its model is always typed. */
export const CATALOG_PROVIDERS = ['anthropic', 'openai', 'google'] as const;
export type CatalogProvider = typeof CATALOG_PROVIDERS[number];
export const hasCatalog = (p: string): p is CatalogProvider =>
  (CATALOG_PROVIDERS as readonly string[]).includes(p);

export interface CatalogModel {
  id: string;
  name: string;
  reasoning: boolean;
  /** YYYY-MM-DD as models.dev states it; '' when it does not. */
  releaseDate: string;
}

/** provider → models, newest first. The shape of the snapshot too. */
export type Catalog = Record<CatalogProvider, CatalogModel[]>;

// Raw models.dev: providers at the top level, models nested under `.models`.
type RawApi = Record<string, { models?: Record<string, {
  name?: string; reasoning?: boolean; release_date?: string } > }>;

/** models.dev's shape → ours: the three providers, each sorted newest first
 *  (release date descending, id ascending as the tie-break). Pure. */
export function fromModelsDev(raw: RawApi): Catalog {
  const out = {} as Catalog;
  for (const p of CATALOG_PROVIDERS) {
    const models = raw[p]?.models ?? {};
    out[p] = Object.keys(models).map((id) => ({
      id, name: models[id]?.name ?? id,
      reasoning: Boolean(models[id]?.reasoning),
      releaseDate: typeof models[id]?.release_date === 'string' ? models[id].release_date : '',
    })).sort((a, b) => b.releaseDate.localeCompare(a.releaseDate) || a.id.localeCompare(b.id));
  }
  return out;
}

/** One fetch of models.dev, parsed. Throws on any failure — the callers decide
 *  what a failure means (the refresh swallows it, the snapshot script dies). */
export async function fetchCatalog(f: typeof fetch = fetch): Promise<Catalog> {
  const res = await f(`${apiBase()}/api.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`models.dev answered ${res.status}`);
  return fromModelsDev(await res.json() as RawApi);
}

/** Write the snapshot file — the build's and `npm run models:snapshot`'s one
 *  job. Throws when models.dev does not answer. */
export async function writeSnapshot(path = SNAPSHOT_PATH, f: typeof fetch = fetch): Promise<Catalog> {
  const catalog = await fetchCatalog(f);
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);
  return catalog;
}

let snapshotCache: Catalog | null = null;
function snapshot(): Catalog {
  if (snapshotCache) return snapshotCache;
  for (const path of [SNAPSHOT_PATH, SNAPSHOT_FALLBACK]) {
    try { return (snapshotCache = JSON.parse(readFileSync(path, 'utf8')) as Catalog); } catch { /* next */ }
  }
  return (snapshotCache = { anthropic: [], openai: [], google: [] });
}

let mem: { catalog: Catalog; fetchedAt: number } | null = null;
let refreshing: Promise<void> | null = null;

/** Fetch models.dev into memory. Swallows every error: a failed refresh leaves
 *  the last good copy (or the snapshot) answering, and the next stale read
 *  tries again. One in flight at a time. */
export function refreshCatalog(f: typeof fetch = fetch): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = fetchCatalog(f)
    .then((catalog) => { mem = { catalog, fetchedAt: Date.now() }; })
    .catch(() => { if (mem) mem.fetchedAt = Date.now(); })   // back off an hour on the last good copy
    .finally(() => { refreshing = null; });
  return refreshing;
}

/** Where the answer comes from right now — reported by GET /models so a stale
 *  list is distinguishable from a fresh one. */
export type CatalogSource = 'live' | 'snapshot';

/** The catalog, best available now, and a background refresh if it is stale.
 *  Never throws, never waits. */
export function catalog(): { catalog: Catalog; source: CatalogSource } {
  if (!mem || Date.now() - mem.fetchedAt > TTL_MS) void refreshCatalog();
  return mem ? { catalog: mem.catalog, source: 'live' } : { catalog: snapshot(), source: 'snapshot' };
}

/** The models for one provider, newest first; [] for a provider with no
 *  catalog (openai-compatible) or one that is unknown. */
export function modelsFor(provider: string): CatalogModel[] {
  return hasCatalog(provider) ? catalog().catalog[provider] ?? [] : [];
}

/** The newest model listed for a provider — the `model` default when the row
 *  is unset. null when there is nothing to pick from. */
export function latestModel(provider: string | null | undefined): string | null {
  if (!provider) return null;
  return modelsFor(provider)[0]?.id ?? null;
}

/** Test seam: forget the memory copy so the next read starts over. */
export function resetCatalog(): void { mem = null; snapshotCache = null; }
