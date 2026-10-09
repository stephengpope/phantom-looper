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
import { ok, err } from '../HttpApi.js';
import type { PhantomBackend } from '../../PhantomBackend.js';
import { PresetError } from '../../storage/Presets.js';

const TAG = { tags: ['presets'] };

export function presetRoutes(app: FastifyInstance, ctx: PhantomBackend) {
  app.get('/presets', { config: { serviceRole: true }, schema: { ...TAG, summary: 'List model presets',
    description: 'The saved sets of model settings, by name.' } },
  async () => {
    const rows = await ctx.presets.list();
    return ok(rows.map((row) => ({
      id: row.id, name: row.name, values: row.values,
      created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
    })));
  });

  app.put<{ Params: { id: string }; Body: { name: string; values?: Record<string, unknown> } }>(
    '/presets/:id', { config: { serviceRole: true }, schema: { ...TAG, summary: 'Save a model preset',
      description: 'Creates or replaces a named set of model settings.',
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
      } catch (error) {
        if (error instanceof PresetError) return reply.code(400).send(err(error.code, error.message));
        throw error;
      }
    });

  app.delete<{ Params: { id: string } }>(
    '/presets/:id', { config: { serviceRole: true }, schema: { ...TAG, summary: 'Delete a model preset',
      description: 'Deletes one saved set of model settings.',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
    async (req, reply) => {
      if (!await ctx.presets.remove(req.params.id)) return reply.code(404).send(err('not_found', 'no such preset'));
      return ok({ deleted: req.params.id });
    });
}
