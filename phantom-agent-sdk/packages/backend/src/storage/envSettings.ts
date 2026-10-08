// Settings fixed by the environment: SETTING_<KEY> (SETTING_SMTP_HOST=…) fixes
// <key> for this deployment — config in the environment, the 12-factor way.
// Optional: with none set, nothing changes. A fixed value wins everywhere,
// cannot be written through the API, and reads as source `fixed` — exactly
// as a value the app fixed in its constructor.
//
// Read once at boot (a change is an edit to .env and a restart). A variable
// that names no setting, or holds a value the setting refuses, stops the
// boot with the reason — a typo is never silently ignored. One the app's
// constructor also fixes, to another value, stops it too, naming both.
import type { Settings } from './Settings.js';

export const ENV_PREFIX = 'SETTING_';

/** The values the environment fixes, by key, typed by each key's definition. */
export function settingsFromEnv(settings: Settings, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const byName = new Map(settings.registeredKeys().map((key) => [`${ENV_PREFIX}${key.toUpperCase()}`, key]));
  const fixed: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith(ENV_PREFIX) || raw === undefined) continue;
    const key = byName.get(name);
    if (!key) throw new Error(`${name} names no setting (SETTING_<KEY>, the key in capitals)`);
    const type = settings.definitionOf(key)!.type;
    if (type === 'boolean') {
      if (!/^(true|false|1|0)$/i.test(raw)) throw new Error(`${name} must be true or false (got "${raw}")`);
      fixed[key] = /^(true|1)$/i.test(raw);
    } else if (type === 'number') {
      const number = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(number)) throw new Error(`${name} must be a number (got "${raw}")`);
      fixed[key] = number;
    } else {
      fixed[key] = raw;
    }
  }
  return fixed;
}
