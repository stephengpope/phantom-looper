// The model catalog behind /model's picker. Source of truth is models.dev
// (the same public, credential-free registry hermes and pi use); we keep a
// bundled snapshot beside this file as the offline fallback and a per-user
// cache under ~/.phantom-cli so a launch never blocks on the network.
//
// Resolution, all synchronous and never-throwing so the settings screen stays
// usable offline: cache (if present, whatever its age) -> bundled snapshot.
// Freshness only decides whether to kick a background refresh; a week-old
// cache still beats the snapshot, so we use it and refresh behind it.
//
// The catalog is a CONVENIENCE, never a fence: /model always keeps a "type a
// custom id" path (ValueInput), so a model that landed on models.dev an hour
// ago — or a private one that never will — is always reachable.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from './config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(HERE, 'models-snapshot.json');
const CACHE_PATH = join(CONFIG_DIR, 'models-cache.json');
const CATALOG_URL = 'https://models.dev/api.json';
const TTL_MS = 24 * 60 * 60 * 1000;

// Only providers whose native ids this TUI can call directly. `openai-compatible`
// is deliberately absent: its models live behind an arbitrary endpoint, so
// there is no registry to list — that provider always uses the custom-id path.
export const CATALOG_PROVIDERS = ['anthropic', 'openai', 'google'] as const;

export interface CatalogModel { id: string; label: string; reasoning: boolean }

/** Flattened registry: provider -> id -> metadata. This is the shape stored in
 *  both the snapshot and the cache (models.dev nests models one level deeper). */
type Entry = { name?: string; reasoning?: boolean };
type Registry = Record<string, Record<string, Entry>>;
interface Cache { fetchedAt: number; data: Registry }

function readJsonFile<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; }
  catch { return null; }
}

let bundled: Registry | null = null;
function snapshot(): Registry {
  return (bundled ??= readJsonFile<Registry>(SNAPSHOT_PATH) ?? {});
}

function cache(): Cache | null {
  if (!existsSync(CACHE_PATH)) return null;
  const c = readJsonFile<Cache>(CACHE_PATH);
  return c && typeof c === 'object' && c.data ? c : null;
}

/** Best available source right now, synchronous and never throwing. */
function registry(): Registry {
  return cache()?.data ?? snapshot();
}

/** True when there is no cache or it has aged past the TTL — the signal to
 *  refresh in the background, NOT a reason to withhold the snapshot. */
function stale(): boolean {
  const c = cache();
  return !c || Date.now() - c.fetchedAt > TTL_MS;
}

/** Catalog models for a provider, id-sorted. Empty for `openai-compatible`,
 *  unknown providers, or when nothing is available. */
export function modelsFor(provider: string): CatalogModel[] {
  if (!CATALOG_PROVIDERS.includes(provider as (typeof CATALOG_PROVIDERS)[number])) return [];
  const models = registry()[provider] ?? {};
  return Object.entries(models)
    .map(([id, m]) => ({ id, label: m?.name ?? id, reasoning: Boolean(m?.reasoning) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Raw models.dev shape: providers keyed at top level, models nested under
// `.models`. We reshape to the flat Registry the snapshot/cache use.
type RawApi = Record<string, { models?: Record<string, Entry> }>;

let refreshing = false;
/** Fire-and-forget refresh from models.dev. No-op if a refresh is in flight or
 *  the cache is still fresh (unless forced). Swallows every error: offline is a
 *  normal state here, and the snapshot already answers. Does not affect any
 *  picker already on screen — the next open reads the new cache. */
export async function refreshCatalog(force = false): Promise<void> {
  if (refreshing) return;
  if (!force && !stale()) return;
  refreshing = true;
  try {
    const res = await fetch(CATALOG_URL);
    if (!res.ok) return;
    const raw = (await res.json()) as RawApi;
    const data: Registry = {};
    for (const p of CATALOG_PROVIDERS) {
      const models = raw[p]?.models ?? {};
      const flat: Record<string, Entry> = {};
      for (const id of Object.keys(models)) {
        flat[id] = { name: models[id]?.name ?? id, reasoning: Boolean(models[id]?.reasoning) };
      }
      data[p] = flat;
    }
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CACHE_PATH, `${JSON.stringify({ fetchedAt: Date.now(), data } satisfies Cache, null, 2)}\n`);
  } catch {
    // offline / parse failure — keep whatever we already have
  } finally {
    refreshing = false;
  }
}
