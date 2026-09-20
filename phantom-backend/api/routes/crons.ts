// Crons, workspace-scoped: a workspace's scheduled prompts (crons.ts) are
// written ONLY through these routes. Addressed by name — the handle a person
// or an agent uses; the row id is storage's. Every schedule is read in the
// workspace's `timezone`, and every answer says which zone and what
// time it is there, so a caller never has to guess either.
//
//   GET    /workspaces/:id/crons            every cron
//   POST   /workspaces/:id/crons            create {name, schedule, prompt, enabled?}
//   PATCH  /workspaces/:id/crons/:name      any subset of those fields
//   DELETE /workspaces/:id/crons/:name
import type { FastifyInstance } from 'fastify';
import type { WorkspaceRow } from '../../db/schema.js';
import type { Clock } from '../../../core/clock.js';
import { CronError, CRON_FIELDS, type CronFields } from '../../crons.js';
import { ok, err, type AppCtx } from '../app.js';

const TAG = { tags: ['crons'] };
const idParam = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
const nameParams = { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] };

const cronBodyProps = {
  name: { type: 'string', description: 'The handle — unique in the workspace, case-insensitively.' },
  schedule: { type: 'string', description: 'A 5-field cron expression ("0 9 * * *") for a recurring cron, or an ISO datetime ("2026-03-14T18:50:00") for a one-time run. Read in the workspace\'s timezone.' },
  prompt: { type: 'string', description: 'What the run is asked to do. Self-contained: the run is a fresh session.' },
  enabled: { type: 'boolean', description: 'false pauses the cron without removing it.' },
};
// The schema must cover THE list (crons.ts) — a field added there without a
// schema entry would be silently stripped by validation. Checked at load.
for (const f of CRON_FIELDS) {
  if (!(f in cronBodyProps)) throw new Error(`cronBodyProps is missing '${f}' — the one field list must cover it`);
}

export function cronRoutes(app: FastifyInstance, ctx: AppCtx) {
  const workspaceOf = (id: string) => ctx.workspaces.get(id);
  const clockOf = (w: WorkspaceRow) => ctx.settings.clock({ workspace: w });
  /** Every answer carries the zone and the time there — what a caller
   *  writing a datetime needs and never otherwise has. */
  const stamp = (clock: Clock) => ({ timezone: clock.timezone, now: clock.now().toISOString() });
  const cronErr = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) => {
    if (!(e instanceof CronError)) throw e;
    return reply.code(e.code === 'not_found' ? 404 : e.code === 'duplicate_name' ? 409 : 400).send(err(e.code, e.message));
  };

  app.get<{ Params: { id: string } }>(
    '/workspaces/:id/crons', { schema: { ...TAG, summary: 'The workspace\'s crons',
      description: 'Every cron, by name: schedule, `once` (a one-time datetime schedule — the row goes when it fires), enabled, ' +
        '`last_run_at`. Plus the workspace\'s `timezone` and the server\'s `now`.',
      params: idParam } },
    async (req, reply) => {
      const w = await workspaceOf(req.params.id);
      if (!w) return reply.code(404).send(err('not_found', `no workspace ${req.params.id}`));
      return ok({ ...stamp(await clockOf(w)), crons: await ctx.crons.list(w) });
    });

  app.post<{ Params: { id: string }; Body: CronFields }>(
    '/workspaces/:id/crons', { schema: { ...TAG, summary: 'Create a cron',
      description: 'The schedule must fire at least once from now in the workspace\'s zone; a datetime that has passed is refused. ' +
        'A name already taken (case-insensitively) is refused with 409.',
      params: idParam,
      body: { type: 'object', additionalProperties: false, required: ['name', 'schedule', 'prompt'], properties: cronBodyProps } } },
    async (req, reply) => {
      const w = await workspaceOf(req.params.id);
      if (!w) return reply.code(404).send(err('not_found', `no workspace ${req.params.id}`));
      const clock = await clockOf(w);
      try { return ok({ ...stamp(clock), cron: await ctx.crons.create(w, req.body, clock) }); }
      catch (e) { return cronErr(reply, e); }
    });

  app.patch<{ Params: { id: string; name: string }; Body: CronFields }>(
    '/workspaces/:id/crons/:name', { schema: { ...TAG, summary: 'Update a cron',
      description: 'Any subset of the fields. A new schedule is checked like a create; `name` renames it (the row stays).',
      params: nameParams,
      body: { type: 'object', additionalProperties: false, properties: cronBodyProps } } },
    async (req, reply) => {
      const w = await workspaceOf(req.params.id);
      if (!w) return reply.code(404).send(err('not_found', `no workspace ${req.params.id}`));
      const clock = await clockOf(w);
      try { return ok({ ...stamp(clock), cron: await ctx.crons.update(w, req.params.name, req.body, clock) }); }
      catch (e) { return cronErr(reply, e); }
    });

  app.delete<{ Params: { id: string; name: string } }>(
    '/workspaces/:id/crons/:name', { schema: { ...TAG, summary: 'Remove a cron',
      description: 'The row goes; the sessions its runs opened stay.', params: nameParams } },
    async (req, reply) => {
      const w = await workspaceOf(req.params.id);
      if (!w) return reply.code(404).send(err('not_found', `no workspace ${req.params.id}`));
      if (!await ctx.crons.remove(w, req.params.name)) {
        return reply.code(404).send(err('not_found', `no cron named "${req.params.name}" in this workspace`));
      }
      return ok({ deleted: req.params.name });
    });
}
