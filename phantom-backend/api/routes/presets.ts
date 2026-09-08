// Provider presets — named snapshots of the 11 model settings.
//
//   GET    /presets          list all, ordered by name
//   PUT    /presets/:id      upsert (name + values); validates values against settings META
//   DELETE /presets/:id      delete
//
// Applying a preset is the CLI's job: it reads the preset, builds a PATCH body
// (11 keys, values or nulls), and calls the existing PATCH /settings — one
// write path, no duplicate validation, no second set of side effects.
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { ok, err, type AppCtx } from '../app.js';
import { presets } from '../../db/schema.js';
import { isSettingKey, validateSetting } from '../../settings.js';

const TAG = { tags: ['presets'] };

/** The setting keys a preset may hold. Everything else is refused. */
const PRESET_KEYS = [
  'provider', 'model', 'base_url', 'reasoning', 'max_steps',
  'assistant_provider', 'assistant_model', 'assistant_base_url',
  'assistant_reasoning', 'assistant_max_steps',
  'supervisor_provider', 'supervisor_model', 'supervisor_base_url',
  'supervisor_reasoning', 'supervisor_max_steps',
] as const;
const PRESET_KEY_SET = new Set<string>(PRESET_KEYS);

export function presetRoutes(app: FastifyInstance, ctx: AppCtx) {
  app.get('/presets', { schema: { ...TAG, summary: 'List presets',
    description: 'Every saved provider preset, ordered by name.' } },
  async () => {
    const rows = await ctx.db.select().from(presets).orderBy(presets.name);
    return ok(rows.map((r) => ({
      id: r.id, name: r.name, values: r.values,
      created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString(),
    })));
  });

  app.put<{ Params: { id: string }; Body: { name: string; values?: Record<string, unknown> } }>(
    '/presets/:id', { schema: { ...TAG, summary: 'Create or update a preset',
      description: 'Body: {name, values}. values holds only the 11 model keys; unknown keys are refused. ' +
        'Each value is validated against the same rules PATCH /settings uses.',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object', properties: {
        name: { type: 'string', minLength: 1 },
        values: { type: 'object', additionalProperties: true },
      }, required: ['name'] } } },
    async (req, reply) => {
      const { name, values = {} } = req.body;
      // Reject unknown keys.
      const bad = Object.keys(values).filter((k) => !PRESET_KEY_SET.has(k));
      if (bad.length) {
        return reply.code(400).send(err('unknown_preset_key',
          `presets may only hold model keys; unknown: ${bad.join(', ')}`));
      }
      // Three states per key:
      //   present with a value  → "set" — apply writes this value
      //   present with null     → "clear" — apply nulls the setting (cascade takes over)
      //   absent from object    → "leave unchanged" — apply does not touch the setting
      // Validate non-null values against the same META the settings routes use.
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) {
        if (v === undefined) continue;           // undefined = leave unchanged (strip it)
        if (v === null) { clean[k] = null; continue; }  // null = clear
        if (isSettingKey(k)) {
          const problem = validateSetting(k as never, v);
          if (problem) return reply.code(400).send(err('invalid_preset_value', problem));
        }
        clean[k] = v;
      }
      const now = new Date();
      await ctx.db.insert(presets)
        .values({ id: req.params.id, name, values: clean, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [presets.id],
          set: { name, values: clean, updatedAt: now },
        });
      return ok({ id: req.params.id, name, values: clean });
    });

  app.delete<{ Params: { id: string } }>(
    '/presets/:id', { schema: { ...TAG, summary: 'Delete a preset',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
    async (req, reply) => {
      const gone = await ctx.db.delete(presets)
        .where(eq(presets.id, req.params.id))
        .returning({ id: presets.id });
      if (!gone.length) return reply.code(404).send(err('not_found', 'no such preset'));
      return ok({ deleted: req.params.id });
    });
}
