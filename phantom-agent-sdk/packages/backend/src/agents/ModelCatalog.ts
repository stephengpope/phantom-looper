// ModelCatalog — models.dev, held by THIS backend for every client. The
// cli's /model picker, the wizard's model question and the "newest model"
// default all read it here, so there is one list and one notion of newest.
//
// Reads are synchronous and never throw (settings resolution asks on every
// read):
//   1. the in-memory copy, under an hour old
//   2. the last good copy, whatever its age — a fetch failure never blanks it
//   3. the snapshot beside this file (models-snapshot.json)
// A stale or missing memory copy kicks ONE background refresh; the caller is
// answered from whatever is there right now. Offline is a normal state.
//
// The snapshot is written by `writeSnapshot`: the image build runs it so
// every release ships current, and `npm run models:snapshot` refreshes the
// committed one a source run reads. It fails loudly when models.dev does
// not answer — a release must not ship a stale list by accident.
// MODELS_DEV_API_BASE is the test seam.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const apiBase = () => process.env.MODELS_DEV_API_BASE ?? 'https://models.dev';
/** Beside this file in src/ and in dist/ (the package ships both). */
const SNAPSHOT_PATH = join(import.meta.dirname, 'models-snapshot.json');
const TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

/** Only providers whose native ids the agents call directly. openai-compatible
 *  is an arbitrary endpoint with no registry to list: its model is always
 *  typed. models.dev lists Kimi under 'moonshotai'; PROVIDER_CATALOG_KEY maps it. */
export const CATALOG_PROVIDERS = ['anthropic', 'openai', 'google', 'deepseek', 'kimi', 'xai', 'mistral', 'groq'] as const;
export type CatalogProvider = typeof CATALOG_PROVIDERS[number];
const PROVIDER_CATALOG_KEY: Record<CatalogProvider, string> = {
  anthropic: 'anthropic', openai: 'openai', google: 'google', deepseek: 'deepseek', kimi: 'moonshotai', xai: 'xai', mistral: 'mistral', groq: 'groq',
};
export const hasCatalog = (provider: string): provider is CatalogProvider =>
  (CATALOG_PROVIDERS as readonly string[]).includes(provider);

export interface CatalogModel {
  id: string;
  name: string;
  reasoning: boolean;
  /** ISO date; '' when models.dev has none. Newest first is the list order. */
  releaseDate: string;
  /** Tokens; 0 when unknown. */
  contextWindow: number;
}
export type Catalog = Record<CatalogProvider, CatalogModel[]>;
/** Where the answer comes from right now — a stale list is distinguishable from a fresh one. */
export type CatalogSource = 'live' | 'snapshot';

// Raw models.dev: providers at the top level, models nested under `.models`.
type RawApi = Record<string, { models?: Record<string, {
  name?: string; reasoning?: boolean; release_date?: string;
  limit?: { context?: number } }> }>;

/** models.dev's shape → ours: each provider sorted newest first (release
 *  date descending, id ascending as the tie-break). Pure. */
export function fromModelsDev(raw: RawApi): Catalog {
  const out = {} as Catalog;
  for (const provider of CATALOG_PROVIDERS) {
    const models = raw[PROVIDER_CATALOG_KEY[provider]]?.models ?? {};
    out[provider] = Object.keys(models).map((id) => ({
      id, name: models[id]?.name ?? id,
      reasoning: Boolean(models[id]?.reasoning),
      releaseDate: typeof models[id]?.release_date === 'string' ? models[id].release_date : '',
      contextWindow: Number(models[id]?.limit?.context) || 0,
    })).sort((a, b) => b.releaseDate.localeCompare(a.releaseDate) || a.id.localeCompare(b.id));
  }
  return out;
}

/** One fetch of models.dev, parsed. Throws on any failure — the caller
 *  decides what a failure means (the refresh swallows it, the snapshot
 *  script dies). */
export async function fetchCatalog(fetchImpl: typeof fetch = fetch): Promise<Catalog> {
  const response = await fetchImpl(`${apiBase()}/api.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
  return fromModelsDev(await response.json() as RawApi);
}

/** Write the snapshot file — the build's and `npm run models:snapshot`'s
 *  one job. Throws when models.dev does not answer. */
export async function writeSnapshot(path = SNAPSHOT_PATH, fetchImpl: typeof fetch = fetch): Promise<Catalog> {
  const catalog = await fetchCatalog(fetchImpl);
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);
  return catalog;
}

export class ModelCatalog {
  #snapshot: Catalog | null = null;
  #live: { catalog: Catalog; fetchedAt: number } | null = null;
  #refreshing: Promise<void> | null = null;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** Fetch models.dev into memory. Swallows every error: a failed refresh
   *  leaves the last good copy (or the snapshot) answering, and the next
   *  stale read tries again. One in flight at a time. */
  refresh(): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = fetchCatalog(this.fetchImpl)
      .then((catalog) => { this.#live = { catalog, fetchedAt: Date.now() }; })
      .catch(() => { if (this.#live) this.#live.fetchedAt = Date.now(); })   // back off an hour on the last good copy
      .finally(() => { this.#refreshing = null; });
    return this.#refreshing;
  }

  /** The catalog, best available now, and a background refresh if it is
   *  stale. Never throws, never waits. */
  current(): { catalog: Catalog; source: CatalogSource } {
    if (!this.#live || Date.now() - this.#live.fetchedAt > TTL_MS) void this.refresh();
    return this.#live ? { catalog: this.#live.catalog, source: 'live' } : { catalog: this.snapshot(), source: 'snapshot' };
  }

  source(): CatalogSource { return this.current().source; }

  /** The models for one provider, newest first; [] for a provider with no
   *  catalog (openai-compatible) or one that is unknown. openai-codex runs
   *  the same models as openai (through a ChatGPT subscription instead of
   *  an API key), so it shares the openai catalog. */
  modelsFor(provider: string): CatalogModel[] {
    const catalogProvider = provider === 'openai-codex' ? 'openai' : provider;
    return hasCatalog(catalogProvider) ? this.current().catalog[catalogProvider] ?? [] : [];
  }

  /** The newest model listed for a provider — the `model` default when the
   *  row is unset. null when there is nothing to pick from. */
  latestFor(provider: string | null | undefined): string | null {
    if (!provider) return null;
    return this.modelsFor(provider)[0]?.id ?? null;
  }

  /** The context window (tokens) for a provider+model pair. 0 when unknown. */
  contextWindowOf(provider: string, model: string): number {
    return this.modelsFor(provider).find((candidate) => candidate.id === model)?.contextWindow ?? 0;
  }

  private snapshot(): Catalog {
    if (this.#snapshot) return this.#snapshot;
    try { return (this.#snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Catalog); } catch { /* no snapshot beside us */ }
    const empty = {} as Catalog;
    for (const provider of CATALOG_PROVIDERS) empty[provider] = [];
    return (this.#snapshot = empty);
  }
}
