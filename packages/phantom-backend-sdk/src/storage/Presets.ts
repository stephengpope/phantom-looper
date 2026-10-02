// The preset row's one owner: named snapshots of the model settings
// (provider/model/base_url per agent, reasoning, max_steps) a client applies
// as one gesture. The values a preset may hold, and how each is validated,
// are decided here — the same rules PATCH /settings applies.
import { eq } from 'drizzle-orm';
import { Database, type Drizzle } from './Database.js';
import { presets, type PresetRow } from './schema.js';
import type { Settings } from './Settings.js';
export type { PresetRow };

export class PresetError extends Error {
  constructor(readonly code: 'unknown_preset_key' | 'invalid_preset_value' | 'duplicate_preset_name', message: string) { super(message); }
}

export class Presets {
  constructor(private readonly db: Drizzle, private readonly settings: Settings) {}

  /** The setting keys a preset may hold: every agent type's `model`
   *  subgroup — read off the registry, the ONE declaration of which
   *  settings are "the model" (a client's preset editor reads the same
   *  fact off GET /settings). Everything else is refused. */
  presetKeys(): string[] {
    return this.settings.keys().filter((key) => this.settings.definitionOf(key)?.subgroup === 'model');
  }

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
    const allowed = new Set(this.presetKeys());
    const bad = Object.keys(values).filter((key) => !allowed.has(key));
    if (bad.length) throw new PresetError('unknown_preset_key', `presets may only hold model keys; unknown: ${bad.join(', ')}`);
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      if (value === null) { clean[key] = null; continue; }
      const problem = this.settings.validate(key, value);
      if (problem) throw new PresetError('invalid_preset_value', problem);
      clean[key] = value;
    }
    const now = new Date();
    try {
      await this.db.insert(presets)
        .values({ id, name, values: clean, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: [presets.id], set: { name, values: clean, updatedAt: now } });
    } catch (error) {
      // The only unique here besides the key is `name`.
      if (Database.isUniqueViolation(error)) throw new PresetError('duplicate_preset_name', `a preset named "${name}" already exists`);
      throw error;
    }
    return clean;
  }

  /** Returns whether a preset was there to remove. */
  async remove(id: string): Promise<boolean> {
    const gone = await this.db.delete(presets).where(eq(presets.id, id)).returning({ id: presets.id });
    return gone.length > 0;
  }
}
