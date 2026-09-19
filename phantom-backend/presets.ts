// The preset row's one owner: named snapshots of the model settings
// (provider/model/base_url per agent, reasoning, max_steps) a client applies
// as one gesture. The values a preset may hold, and how each is validated,
// are decided here — the same rules PATCH /settings applies.
import { eq } from 'drizzle-orm';
import { isUniqueViolation, type Db } from './db/client.js';
import { presets, type PresetRow } from './db/schema.js';
import { META, isSettingKey, validateSetting, type SettingKey } from './settings.js';

/** The setting keys a preset may hold: every agent's `model` rows — read off
 *  META's `subgroup`, the ONE declaration of which settings are "the model"
 *  (the cli's preset editor reads the same fact off GET /settings). Everything
 *  else is refused. */
export const PRESET_KEYS: readonly SettingKey[] =
  (Object.keys(META) as SettingKey[]).filter((k) => META[k].subgroup === 'model');
const PRESET_KEY_SET = new Set<string>(PRESET_KEYS);

export class PresetError extends Error {
  constructor(readonly code: 'unknown_preset_key' | 'invalid_preset_value' | 'duplicate_preset_name', message: string) { super(message); }
}

export class Presets {
  constructor(private readonly db: Db) {}

  /** Every preset, by name. */
  async list(): Promise<PresetRow[]> {
    return this.db.select().from(presets).orderBy(presets.name);
  }

  /** Create or overwrite. Three states per key: present with a value = "set";
   *  present with null = "clear" (apply nulls the setting, the cascade takes
   *  over); absent = "leave unchanged". Unknown keys, invalid values and a
   *  name another preset already has are refused. Returns the values as
   *  stored. */
  async save(id: string, name: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
    const bad = Object.keys(values).filter((k) => !PRESET_KEY_SET.has(k));
    if (bad.length) throw new PresetError('unknown_preset_key', `presets may only hold model keys; unknown: ${bad.join(', ')}`);
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) continue;
      if (v === null) { clean[k] = null; continue; }
      if (isSettingKey(k)) {
        const problem = validateSetting(k, v);
        if (problem) throw new PresetError('invalid_preset_value', problem);
      }
      clean[k] = v;
    }
    const now = new Date();
    try {
      await this.db.insert(presets)
        .values({ id, name, values: clean, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: [presets.id], set: { name, values: clean, updatedAt: now } });
    } catch (e) {
      // The only unique here besides the key is `name`.
      if (isUniqueViolation(e)) throw new PresetError('duplicate_preset_name', `a preset named "${name}" already exists`);
      throw e;
    }
    return clean;
  }

  /** Returns whether a preset was there to remove. */
  async remove(id: string): Promise<boolean> {
    const gone = await this.db.delete(presets).where(eq(presets.id, id)).returning({ id: presets.id });
    return gone.length > 0;
  }
}
