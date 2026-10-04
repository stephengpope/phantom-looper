// Crons, project-scoped: a project's scheduled prompts (crons.ts) are
// written ONLY through these routes. Addressed by name — the handle a person
// or an agent uses; the row id is storage's. Every schedule is read in the
// project's `timezone`, and every answer says which zone and what
// time it is there, so a caller never has to guess either.
//
//   GET    /projects/:id/crons            every cron
//   POST   /projects/:id/crons            create {name, schedule, prompt | script, provider?+model?, reasoning?, enabled?}
//   PATCH  /projects/:id/crons/:name      any subset of those fields
//   DELETE /projects/:id/crons/:name
import type { FastifyInstance } from 'fastify';
import type { ProjectRow } from '../../storage/schema.js';
import type { Clock } from '../../lib/clock.js';
import { CronError, CRON_FIELDS, type CronFields } from '../../storage/Crons.js';
import { REASONINGS } from 'phantom-client-sdk';
import { ok, err } from '../HttpApi.js';
import type { PhantomBackend } from '../../PhantomBackend.js';

const TAG = { tags: ['crons'] };
const idParam = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
const nameParams = { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] };

const cronBodyProps = {
  name: { type: 'string', description: 'The handle — unique in the project, case-insensitively.' },
  schedule: { type: 'string', description: 'A 5-field cron expression ("0 9 * * *") for a recurring cron, or an ISO datetime ("2026-03-14T18:50:00") for a one-time run. Read in the project\'s timezone.' },
  prompt: { type: 'string', description: 'What an agent run is asked to do. Self-contained: the run is a fresh session. Exactly one of prompt / script.' },
  script: { type: 'string', description: 'A path in the repo, run with sh in the session\'s container — no model, no tokens. Exactly one of prompt / script.' },
  provider: { type: ['string', 'null'], description: 'Run on this provider instead of the project\'s — one with a key on /keys (Crons refuses others, naming the ones that have one). Goes with `model`: both or neither. Null = the project\'s.' },
  model: { type: ['string', 'null'], description: 'The model id on that provider. Goes with `provider`: both or neither. Null = the project\'s.' },
  reasoning: { type: ['string', 'null'], enum: [...REASONINGS, null], description: 'How hard the run thinks. Null = the project\'s.' },
  enabled: { type: 'boolean', description: 'false pauses the cron without removing it.' },
};
// The schema must cover THE list (crons.ts) — a field added there without a
// schema entry would be silently stripped by validation. Checked at load.
for (const field of CRON_FIELDS) {
  if (!(field in cronBodyProps)) throw new Error(`cronBodyProps is missing '${field}' — the one field list must cover it`);
}

export function cronRoutes(app: FastifyInstance, ctx: PhantomBackend) {
  const projectOf = (id: string) => ctx.projects.get(id);
  const clockOf = (project: ProjectRow) => ctx.settings.clockFor({ projectId: project.id });
  /** Every answer carries the zone and the time there — what a caller
   *  writing a datetime needs and never otherwise has. */
  const stamp = (clock: Clock) => ({ timezone: clock.timezone, now: clock.now().toISOString() });
  const cronErr = (reply: { code: (status: number) => { send: (b: unknown) => unknown } }, error: unknown) => {
    if (!(error instanceof CronError)) throw error;
    return reply.code(error.code === 'not_found' ? 404 : error.code === 'duplicate_name' ? 409 : 400).send(err(error.code, error.message));
  };

  app.get<{ Params: { id: string } }>(
    '/projects/:id/crons', { schema: { ...TAG, summary: 'The project\'s crons',
      description: 'Every cron, by name: schedule, `once` (a one-time datetime schedule — the row goes when it fires), enabled, ' +
        '`last_run_at`, and the model its runs pin to (`provider`/`model`/`reasoning`; null = the project\'s). ' +
        'Plus the project\'s `timezone` and the server\'s `now`.',
      params: idParam } },
    async (req, reply) => {
      const project = await projectOf(req.params.id);
      if (!project) return reply.code(404).send(err('not_found', `no project ${req.params.id}`));
      return ok({ ...stamp(await clockOf(project)), crons: await ctx.crons.list(project) });
    });

  app.post<{ Params: { id: string }; Body: CronFields }>(
    '/projects/:id/crons', { schema: { ...TAG, summary: 'Create a cron',
      description: 'The schedule must fire at least once from now in the project\'s zone; a datetime that has passed is refused. ' +
        'Exactly one of prompt / script. A name already taken (case-insensitively) is refused with 409.',
      params: idParam,
      body: { type: 'object', additionalProperties: false, required: ['name', 'schedule'], properties: cronBodyProps } } },
    async (req, reply) => {
      const project = await projectOf(req.params.id);
      if (!project) return reply.code(404).send(err('not_found', `no project ${req.params.id}`));
      const clock = await clockOf(project);
      try { return ok({ ...stamp(clock), cron: await ctx.crons.create(project, req.body, clock) }); }
      catch (error) { return cronErr(reply, error); }
    });

  app.patch<{ Params: { id: string; name: string }; Body: CronFields }>(
    '/projects/:id/crons/:name', { schema: { ...TAG, summary: 'Update a cron',
      description: 'Any subset of the fields. A new schedule is checked like a create; `name` renames it (the row stays).',
      params: nameParams,
      body: { type: 'object', additionalProperties: false, properties: cronBodyProps } } },
    async (req, reply) => {
      const project = await projectOf(req.params.id);
      if (!project) return reply.code(404).send(err('not_found', `no project ${req.params.id}`));
      const clock = await clockOf(project);
      try { return ok({ ...stamp(clock), cron: await ctx.crons.update(project, req.params.name, req.body, clock) }); }
      catch (error) { return cronErr(reply, error); }
    });

  app.delete<{ Params: { id: string; name: string } }>(
    '/projects/:id/crons/:name', { schema: { ...TAG, summary: 'Remove a cron',
      description: 'The row goes; the sessions its runs opened stay.', params: nameParams } },
    async (req, reply) => {
      const project = await projectOf(req.params.id);
      if (!project) return reply.code(404).send(err('not_found', `no project ${req.params.id}`));
      if (!await ctx.crons.remove(project, req.params.name)) {
        return reply.code(404).send(err('not_found', `no cron named "${req.params.name}" in this project`));
      }
      return ok({ deleted: req.params.name });
    });
}
