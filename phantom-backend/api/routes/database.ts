// The agent's own database, per workspace (databases.ts). Two routes, both
// behind the workspace's `agent_database` setting — the ONE place that says
// whether the agent has a database:
//
//   GET  /workspaces/:id/database         { enabled }   — the tool kit asks before it offers database_query
//   POST /workspaces/:id/database/query   { sql, limit } — run it, connected as the workspace's role
import type { FastifyInstance } from 'fastify';
import { SqlError } from '../../databases.js';
import { ok, err, type AppCtx } from '../app.js';

const TAG = { tags: ['database'] };
const idParam = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };

export function databaseRoutes(app: FastifyInstance, ctx: AppCtx) {
  app.get<{ Params: { id: string } }>(
    '/workspaces/:id/database', { schema: { ...TAG,
      summary: 'Whether the agent has its own database in this workspace',
      description: 'The `agent_database` setting resolved at this workspace\'s layer. The coding agent\'s tool kit reads it: on, the database_query tool is offered; off, it is not.',
      params: idParam } },
    async (req, reply) => {
      const workspace = await ctx.workspaces.get(req.params.id);
      if (!workspace) return reply.code(404).send(err('not_found', `no workspace ${req.params.id}`));
      const enabled = Boolean(await ctx.settings.resolve('agent_database', { workspace }));
      return ok({ enabled });
    });

  app.post<{ Params: { id: string }; Body: { sql: string; limit?: number; maxCellChars?: number; params?: unknown[] } }>(
    '/workspaces/:id/database/query', { schema: { ...TAG,
      summary: 'Run SQL in the agent\'s own database',
      description: 'Run connected as the workspace\'s own role in its own database — the agent is the admin there and nothing else. ' +
        'Several statements run as ONE transaction: an error undoes the whole call. No session state survives between calls. ' +
        '30 s statement timeout. `params` fills $1…$n and needs a single statement. One result per statement: Postgres\'s command tag, ' +
        'the TRUE row count, and the first `limit` rows; cells past `maxCellChars` end in `…[truncated, N chars]`. Duplicate column ' +
        'names are refused. The database and role are created on first use. 409 `database_off` when the setting is off; 400 `sql_error` ' +
        'with Postgres\'s own message, code, the object it names, and (for parse errors) line/column; 503 when this server has no database wiring.',
      params: idParam,
      body: { type: 'object', required: ['sql'], additionalProperties: false,
        properties: {
          sql: { type: 'string', minLength: 1 },
          limit: { type: 'integer', minimum: 1, default: 10, description: 'rows returned per statement; rowCount is always the true total' },
          maxCellChars: { type: 'integer', minimum: 1, default: 1000, description: 'longest cell returned whole; longer ones end in …[truncated, N chars]' },
          params: { type: 'array', description: 'values for $1…$n; single statement only' },
        } } } },
    async (req, reply) => {
      if (!ctx.databases) return reply.code(503).send(err('database_unavailable', 'this server has no agent database wiring'));
      const workspace = await ctx.workspaces.get(req.params.id);
      if (!workspace) return reply.code(404).send(err('not_found', `no workspace ${req.params.id}`));
      if (!(await ctx.settings.resolve('agent_database', { workspace }))) {
        return reply.code(409).send(err('database_off', 'agent_database is off for this workspace'));
      }
      try {
        const results = await ctx.databases.query(workspace.id, req.body.sql, {
          limit: req.body.limit ?? 10, maxCellChars: req.body.maxCellChars ?? 1000, params: req.body.params,
        });
        return ok({ results });
      } catch (e) {
        if (e instanceof SqlError) {
          return reply.code(400).send(err('sql_error', e.message, false,
            { ...e.info, rolledBack: 'nothing in this call was applied' }));
        }
        throw e;
      }
    });
}
