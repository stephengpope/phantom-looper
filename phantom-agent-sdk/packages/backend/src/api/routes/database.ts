// The agent's own database, per project (databases.ts). Two routes, both
// behind the project's `agent_database` setting — the ONE place that says
// whether the agent has a database:
//
//   GET  /projects/:id/database         { enabled }   — the tool kit asks before it offers database_query
//   POST /projects/:id/database/query   { sql, limit } — run it, connected as the project's role
import type { FastifyInstance } from 'fastify';
import { SqlError } from '../../storage/AgentDatabases.js';
import { ok, err } from '../HttpApi.js';
import type { PhantomBackend } from '../../PhantomBackend.js';
import { scopeOf } from '../../lib/scopes.js';

const TAG = { tags: ['database'] };
const idParam = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };

export function databaseRoutes(app: FastifyInstance, ctx: PhantomBackend) {
  app.get<{ Params: { id: string } }>(
    '/projects/:id/database', { schema: { ...TAG,
      summary: 'Check the agent database',
      description: 'Whether the project\'s agent has its own PostgreSQL database turned on.',
      params: idParam } },
    async (req, reply) => {
      const project = await ctx.projects.get(req.params.id);
      if (!project) return reply.code(404).send(err('not_found', `no project ${req.params.id}`));
      const enabled = Boolean(await ctx.settings.resolve('agent_database', scopeOf(project)));
      return ok({ enabled });
    });

  app.post<{ Params: { id: string }; Body: { sql: string; limit?: number; maxCellChars?: number; params?: unknown[] } }>(
    '/projects/:id/database/query', { schema: { ...TAG,
      summary: 'Query the agent database',
      description: 'Runs SQL in the project\'s agent database and returns the result of each statement.',
      params: idParam,
      body: { type: 'object', required: ['sql'], additionalProperties: false,
        properties: {
          sql: { type: 'string', minLength: 1 },
          limit: { type: 'integer', minimum: 1, default: 10, description: 'rows returned per statement; rowCount is always the true total' },
          maxCellChars: { type: 'integer', minimum: 1, default: 1000, description: 'longest cell returned whole; longer ones end in …[truncated, N chars]' },
          params: { type: 'array', description: 'values for $1…$n; single statement only' },
        } } } },
    async (req, reply) => {
      if (!ctx.agentDatabases) return reply.code(503).send(err('database_unavailable', 'this server has no agent database wiring'));
      const project = await ctx.projects.get(req.params.id);
      if (!project) return reply.code(404).send(err('not_found', `no project ${req.params.id}`));
      if (!(await ctx.settings.resolve('agent_database', scopeOf(project)))) {
        return reply.code(409).send(err('database_off', 'agent_database is off for this project'));
      }
      try {
        const results = await ctx.agentDatabases.query(project.id, req.body.sql, {
          limit: req.body.limit ?? 10, maxCellChars: req.body.maxCellChars ?? 1000, params: req.body.params,
        });
        return ok({ results });
      } catch (error) {
        if (error instanceof SqlError) {
          return reply.code(400).send(err('sql_error', error.message, false,
            { ...error.info, rolledBack: 'nothing in this call was applied' }));
        }
        throw error;
      }
    });
}
