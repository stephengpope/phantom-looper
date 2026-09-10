// The settings that stay on this machine, and the file they live in.
//
// Two of them are how you REACH the server (`server_url`, `server_key`) — they
// cannot live on the thing they are the address of, and you edit them precisely
// when it is unreachable, so nothing here makes a network call. `auto_update`
// is this machine's own update preference (the server would share one choice
// across every TUI you open). The rest are facts about the machine you are
// sitting at: which microphone, which
// speaker, whether you are wearing headphones, whether you muted yourself here.
// A device name is simply wrong on your other machine; so is the Deepgram address
// that answers from here (the engine finds it, the app saves it).
//
// Everything else is on the server (settings.ts), so every TUI you open is the
// same one. Reads here are synchronous because a file read is; a call site can
// tell which kind it is by whether it awaits.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CONFIG_PATH, DEFAULTS, META, LOCAL_KEYS, validate,
  type LocalKey, type ConfigValue,
} from './config.js';

export type Source = 'default' | 'file' | 'env';
export interface Resolved { value: ConfigValue; source: Source; envVar?: string }

/** Whatever is on disk. A corrupt file must NOT be silently rewritten: that
 *  destroys the very keys someone is trying to recover. Warn and carry on with
 *  defaults instead. EVERY key comes back here, known or not: keys that moved
 *  to the server (an older TUI pointed at the same file still reads them) and
 *  the app's own bookkeeping (last_update_check) must survive every write —
 *  dropping them is how a settings file earns its "never touch it" hacks. */
export function readOverrides(path = CONFIG_PATH): { overrides: Record<string, ConfigValue>; error?: string } {
  if (!existsSync(path)) return { overrides: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  // The verdict first: a narrow screen truncates the tail, and the path is
  // the part that can go.
  catch (e) { return { overrides: {}, error: `settings file is not valid JSON — using defaults; it has not been touched (${path}: ${(e as Error).message})` }; }
  if (!parsed || typeof parsed !== 'object') return { overrides: {}, error: `settings file is not an object — using defaults (${path})` };
  return { overrides: parsed as Record<string, ConfigValue>, error: undefined };
}

function envValue(key: LocalKey, env: NodeJS.ProcessEnv): { value: string; envVar: string } | undefined {
  for (const name of META[key].env ?? []) {
    const v = env[name];
    if (v) return { value: v, envVar: name };
  }
  return undefined;
}

/** The whole local chain, with provenance. Env still wins so scripts and CI
 *  keep working — and it only reaches these seven, so a server-side value can
 *  never be shadowed by something in your shell. */
export function resolveLocal(
  path = CONFIG_PATH, env: NodeJS.ProcessEnv = process.env,
): { config: Record<LocalKey, Resolved>; error?: string } {
  const { overrides, error } = readOverrides(path);
  const out = {} as Record<LocalKey, Resolved>;
  for (const key of LOCAL_KEYS) {
    let r: Resolved = { value: DEFAULTS[key] as ConfigValue, source: 'default' };
    if (overrides[key] !== undefined) r = { value: overrides[key] as ConfigValue, source: 'file' };
    const e = envValue(key, env);
    if (e) {
      const v: ConfigValue = META[key].type === 'number' ? Number(e.value)
        : META[key].type === 'boolean' ? e.value !== 'false' && e.value !== '0'
          : e.value;
      r = { value: v, source: 'env', envVar: e.envVar };
    }
    out[key] = r;
  }
  return { config: out, error };
}

/** Plain values, for the code that just needs the answer. */
export function localValues(path = CONFIG_PATH, env: NodeJS.ProcessEnv = process.env): Record<LocalKey, ConfigValue> {
  const { config } = resolveLocal(path, env);
  return Object.fromEntries(
    LOCAL_KEYS.map((k) => [k, config[k].value]),
  ) as Record<LocalKey, ConfigValue>;
}

/** 0600 is applied with an explicit chmod, NOT the writeFileSync mode option:
 *  that option is ignored when the file already exists, so a settings.json that
 *  was ever 0644 would silently stay 0644 while holding the API key. The write
 *  is tmp-then-rename: a crash lands the old file or the new one, never half
 *  of one — this file holds the API key. */
function writeOverrides(overrides: Record<string, ConfigValue>, path = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(overrides, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Set one local override. Returns an error message instead of throwing. */
export function setLocal(key: LocalKey, value: ConfigValue, path = CONFIG_PATH): string | null {
  const bad = validate(key, value);
  if (bad) return bad;
  const { overrides, error } = readOverrides(path);
  if (error) return error;   // never overwrite a file we could not read
  overrides[key] = value;
  writeOverrides(overrides, path);
  return null;
}

/** The app's own bookkeeping (last_update_check) — a key in the same file,
 *  preserved on every write, never shown on the settings screen, never
 *  validated. Same refusal rule as setLocal: a file we could not read is
 *  never overwritten. */
export function setBookkeeping(key: string, value: ConfigValue, path = CONFIG_PATH): void {
  const { overrides, error } = readOverrides(path);
  if (error) return;
  overrides[key] = value;
  writeOverrides(overrides, path);
}

/** Clear one, so the key follows the code default again. */
export function clearLocal(key: LocalKey, path = CONFIG_PATH): string | null {
  const { overrides, error } = readOverrides(path);
  if (error) return error;
  delete overrides[key];
  writeOverrides(overrides, path);
  return null;
}
