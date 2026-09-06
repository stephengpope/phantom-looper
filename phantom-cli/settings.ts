// Settings, read from the API and written to it. Nothing is held.
//
// This file used to hand out a resolved object that the app kept in state and
// passed around. That is a cache, and it goes stale the moment anything writes
// through another door: save a Deepgram key on /keys and the Assistant would
// still spawn with the environment it was born with, so you had to switch voice
// off and on to get a second attempt. There is no object of values to hold any
// more — every read below is a call, answered by the server, at the moment the
// value is used.
//
// ONE flat store on the server (no namespaces): every key is declared in the
// server's code with its default, so `all()` already carries the resolved
// value for every key this client renders. The seven machine-local settings
// (local.ts) need no network, which is what keeps /server usable exactly when
// this is failing — and a read that cannot reach the server THROWS rather than
// showing invented numbers beside real ones.
import { PROVIDER_KEY, type ConfigValue } from './config.js';

export const CREDENTIAL_KEYS = [
  'github_token',
  ...Object.values(PROVIDER_KEY),
  'deepgram_api_key',
  'firecrawl_api_key',
] as const;

export const isCredential = (k: string): boolean =>
  (CREDENTIAL_KEYS as readonly string[]).includes(k);

export type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** One entry as the API returns it: the layers, the winner, and whether it is
 *  stored encrypted. */
export interface Entry {
  default?: unknown; global?: unknown; workspace?: unknown; session?: unknown;
  value: unknown; source?: string; secret?: boolean;
  description?: string; meta?: unknown; overridable?: boolean;
}

export interface Scope { workspace?: string; session?: string }

const q = (s: Scope = {}) => {
  const p = new URLSearchParams();
  if (s.workspace) p.set('workspace', s.workspace);
  if (s.session) p.set('session', s.session);
  const t = p.toString();
  return t ? `?${t}` : '';
};

/** The settings client: one method per route, same shapes and names, so "what
 *  does this do" is answered by the API docs and nothing here has an opinion of
 *  its own. */
export function makeSettings(api: Api) {
  return {
    /** The call the client is built on, for the one-off reads beside the
     *  settings (the catalog, the GitHub check). */
    api,
    /** GET /settings — every setting resolved, with layers/meta/description. */
    all: (scope?: Scope) =>
      api('GET', `/settings${q(scope)}`) as Promise<Record<string, Entry>>,

    /** PATCH /settings — several keys in one call, like the route. null
     *  clears a key at that layer. */
    patch: (values: Record<string, ConfigValue>, scope?: Scope) =>
      api('PATCH', `/settings${q(scope)}`, values) as Promise<{ updated: string[] }>,

    /** DELETE /settings/:key */
    clear: (key: string, scope?: Scope) =>
      api('DELETE', `/settings/${key}${q(scope)}`),

    // ── what this client actually asks for ──────────────────────────────────

    /** Everything this client reads, as plain values. The server declares every
     *  key's default, so the resolved `value` is always present.
     *
     *  Call this AT THE POINT OF USE — when a sidecar spawns, when an agent is
     *  built, when a screen opens. Do not keep the result. */
    async read(): Promise<Record<string, ConfigValue>> {
      const entries = await this.all();
      const out: Record<string, ConfigValue> = {};
      for (const [k, v] of Object.entries(entries ?? {})) out[k] = v.value as ConfigValue;
      return out;
    },

    /** Write one setting. One store — no routing decision to make. */
    write(key: string, value: ConfigValue) {
      return this.patch({ [key]: value });
    },
  };
}

export type Settings = ReturnType<typeof makeSettings>;
