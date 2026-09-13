// Provider presets — named snapshots of the model settings.
//
//   GET    /presets          list all, ordered by name
//   PUT    /presets/:id      upsert (name + values); validates values against settings META
//   DELETE /presets/:id      delete
//
// Applying a preset is the CLI's job: it reads the preset, builds a PATCH body
// (values or nulls), and calls the existing PATCH /settings — one write path,
// no duplicate validation, no second set of side effects.
import type { FastifyInstance } from 'fastify';
import { ok, err, type AppCtx } from '../app.js';
import { PresetError } from '../../presets.js';

const TAG = { tags: ['presets'] };

export function presetRoutes(app: FastifyInstance, ctx: AppCtx) {
  app.get('/presets', { schema: { ...TAG, summary: 'List presets',
    description: 'Every saved provider preset, ordered by name.' } },
  async () => {
    const rows = await ctx.presets.list();
    return ok(rows.map((r) => ({
      id: r.id, name: r.name, values: r.values,
      created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString(),
    })));
  });

  app.put<{ Params: { id: string }; Body: { name: string; values?: Record<string, unknown> } }>(
    '/presets/:id', { schema: { ...TAG, summary: 'Create or update a preset',
      description: 'Body: {name, values}. values holds only the model keys; unknown keys are refused. ' +
        'Each value is validated against the same rules PATCH /settings uses.',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object', properties: {
        name: { type: 'string', minLength: 1 },
        values: { type: 'object', additionalProperties: true },
      }, required: ['name'] } } },
    async (req, reply) => {
      const { name, values = {} } = req.body;
      try {
        const clean = await ctx.presets.save(req.params.id, name, values);
        return ok({ id: req.params.id, name, values: clean });
      } catch (e) {
        if (e instanceof PresetError) return reply.code(400).send(err(e.code, e.message));
        throw e;
      }
    });

  app.delete<{ Params: { id: string } }>(
    '/presets/:id', { schema: { ...TAG, summary: 'Delete a preset',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
    async (req, reply) => {
      if (!await ctx.presets.remove(req.params.id)) return reply.code(404).send(err('not_found', 'no such preset'));
      return ok({ deleted: req.params.id });
    });
}
