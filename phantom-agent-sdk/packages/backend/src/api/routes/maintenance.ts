// Maintenance — the server's upkeep jobs (maintenance/Maintenance.ts), over
// HTTP: what they are, when each last ran and what it did, and a way to run
// one now. Every route is the service role's.
//
//   GET    /maintenance             every job: interval, where it runs, running, last run
//   GET    /maintenance/:name       one job
//   POST   /maintenance/:name/run   run it now → the run record; 409 while it is running
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PhantomBackend } from '../../PhantomBackend.js';
import { MaintenanceError } from '../../maintenance/Maintenance.js';
import { err, ok } from '../HttpApi.js';

const SERVICE_ROLE = { serviceRole: true } as const;
const TAG = { tags: ['meta'] } as const;
const nameParam = { type: 'object', required: ['name'], properties: { name: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' } } };

function refuse(reply: FastifyReply, error: unknown) {
  if (!(error instanceof MaintenanceError)) throw error;
  return reply.code(error.code === 'not_found' ? 404 : 409).send(err(`maintenance_${error.code}`, error.message));
}

export function maintenanceRoutes(app: FastifyInstance, backend: PhantomBackend): void {
  const { maintenance } = backend;

  app.get('/maintenance', {
    config: SERVICE_ROLE,
    schema: { ...TAG, summary: 'List the maintenance jobs',
      description: 'Every upkeep job the server runs on a timer: what it does, where, how often, whether it is running now, and its last run.' },
  }, async () => ok({ jobs: await maintenance.list() }));

  app.get<{ Params: { name: string } }>('/maintenance/:name', {
    config: SERVICE_ROLE,
    schema: { ...TAG, summary: 'Get a maintenance job', description: 'One upkeep job and its last run.', params: nameParam },
  }, async (req, reply) => {
    try { return ok(await maintenance.get(req.params.name)); } catch (error) { return refuse(reply, error); }
  });

  app.post<{ Params: { name: string } }>('/maintenance/:name/run', {
    config: SERVICE_ROLE,
    schema: { ...TAG, summary: 'Run a maintenance job now',
      description: 'Runs the job outside its timer and answers its run record. Refused while the job is already running.', params: nameParam },
  }, async (req, reply) => {
    try { return ok(await maintenance.run(req.params.name)); } catch (error) { return refuse(reply, error); }
  });
}
