// Settings a deployment fixes from its environment. The app lists which
// (PhantomBackendConfig.envSettings); each is read from its own name in
// capitals — smtp_host from SMTP_HOST — and, when set, fixes the setting
// exactly as a constructor value does: it wins everywhere, cannot be written
// through the API, and reads as source `fixed`. Unset: nothing changes.
//
// Read once at boot (a change is an edit to .env and a restart), typed by
// the setting's definition. A listed key that is no setting, or a value the
// setting refuses, stops the boot with the reason.
import type { Settings } from './Settings.js';

export const envName = (key: string) => key.toUpperCase();

export function settingsFromEnv(settings: Settings, keys: readonly string[], env: NodeJS.ProcessEnv): Record<string, unknown> {
  const fixed: Record<string, unknown> = {};
  for (const key of keys) {
    const definition = settings.definitionOf(key);
    if (!definition) throw new Error(`envSettings names ${key}, which is no setting`);
    const name = envName(key);
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    if (definition.type === 'boolean') {
      if (!/^(true|false|1|0)$/i.test(raw)) throw new Error(`${name} must be true or false (got "${raw}")`);
      fixed[key] = /^(true|1)$/i.test(raw);
    } else if (definition.type === 'number') {
      const number = Number(raw);
      if (!Number.isFinite(number)) throw new Error(`${name} must be a number (got "${raw}")`);
      fixed[key] = number;
    } else {
      fixed[key] = raw;
    }
  }
  return fixed;
}
