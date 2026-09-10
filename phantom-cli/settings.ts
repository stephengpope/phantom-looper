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
// Server settings are ONE flat store (no namespaces): every key is declared in
// the server's code with its default, so `all()` carries the resolved value.
// Machine-local settings (local.ts) stay separate and are routed here, which
// keeps /server usable exactly when the server itself is failing. A server
// read that cannot reach the server THROWS rather than inventing values.
import {
  CONFIG_PATH, PROVIDER_KEY, isLocalKey,
  type ConfigValue, type LocalKey,
} from './config.js';
import { localValues, setLocal, clearLocal } from './local.js';

export const CREDENTIAL_KEYS = [
  'github_token',
  ...Object.values(PROVIDER_KEY),
  'deepgram_api_key',
  'firecrawl_api_key',
] as const;

export const isCredential = (k: string): boolean =>
  (CREDENTIAL_KEYS as readonly string[]).includes(k);

export type { Api } from './request.js';
import type { Api } from './request.js';

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

/** The settings client: one door for server settings and this machine's local
 *  ones. A read always asks its store; a write always routes by where the key
 *  lives. The returned values are for the operation in hand, never for keeping. */
export function makeSettings(api: Api, configPath = CONFIG_PATH) {
  const all = (scope?: Scope) =>
    api('GET', `/settings${q(scope)}`) as Promise<Record<string, Entry>>;
  const remotePatch = (values: Record<string, ConfigValue>, scope?: Scope) =>
    api('PATCH', `/settings${q(scope)}`, values) as Promise<{ updated: string[] }>;
  const valuesOf = (entries: Record<string, Entry>): Record<string, ConfigValue> => {
    const out: Record<string, ConfigValue> = {};
    for (const [k, v] of Object.entries(entries ?? {})) out[k] = v.value as ConfigValue;
    return out;
  };

  return {
    /** The call the client is built on, for the one-off reads beside the
     *  settings (the catalog, the GitHub check). */
    api,
    /** GET /settings — every server setting resolved, with layers/meta. */
    all,

    /** Plain values, fresh from the store at the point of use. A global read
     *  overlays this machine's local keys; a scoped read is server-only. */
    async read(scope?: Scope): Promise<Record<string, ConfigValue>> {
      const remote = valuesOf(await all(scope));
      return scope ? remote : { ...remote, ...localValues(configPath) };
    },

    /** Write several settings. Server keys go in one PATCH; machine-local
     *  keys go to the local file. A scoped write is server-only. */
    async patch(values: Record<string, ConfigValue>, scope?: Scope): Promise<{ updated: string[] }> {
      if (scope) return remotePatch(values, scope);
      const remote: Record<string, ConfigValue> = {};
      const local: Array<[LocalKey, ConfigValue]> = [];
      for (const [k, v] of Object.entries(values)) {
        if (isLocalKey(k)) local.push([k, v]); else remote[k] = v;
      }
      const result = Object.keys(remote).length ? await remotePatch(remote) : { updated: [] };
      for (const [k, v] of local) {
        const bad = v === null ? clearLocal(k, configPath) : setLocal(k, v, configPath);
        if (bad) throw new Error(bad);
      }
      return { updated: [...result.updated, ...local.map(([k]) => k)] };
    },

    /** Write one setting. null clears it at the store that owns it. */
    write(key: string, value: ConfigValue, scope?: Scope) {
      return this.patch({ [key]: value }, scope);
    },

    /** Clear one setting. Same write path as PATCH {key:null}; local keys
     *  clear locally, server keys clear on the server. */
    clear(key: string, scope?: Scope) {
      return this.patch({ [key]: null }, scope);
    },
  };
}

export type Settings = ReturnType<typeof makeSettings>;
