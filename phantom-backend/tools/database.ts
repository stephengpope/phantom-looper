// The DATABASE tool — database_query: the agent's own Postgres database for
// the project (databases.ts). Offered when the project's `agent_database`
// is on and the server has database wiring; absent otherwise — a missing
// tool, never a failing one.
import { SqlError } from 'phantom-backend-sdk';
import { obj, refusal, type OfferCtx, type ToolDef } from './def.js';

const enabled = async ({ app, project }: OfferCtx) =>
  !!app.databases && Boolean(await app.settings.resolve('agent_database', { project }));

export const DATABASE_TOOLS: ToolDef[] = [
  {
    name: 'database_query',
    summary: 'Run SQL in your own database.',
    description: 'Run SQL in your own database. Several statements allowed; they run as ONE transaction — any error ' +
      'undoes the whole call. No state survives between calls (SET, TEMP tables, cursors are gone next call). 30 s limit ' +
      'per statement. `params` fills $1…$n and needs a single statement. Rows: the first `limit` (default 10), `rowCount` ' +
      'is the true total. Cells over `maxCellChars` (default 1000) end in `…[truncated, N chars]`. Duplicate column names ' +
      'are refused — alias them. Values: bigint as a number when exact, else a string; numeric/decimal always a string; ' +
      '`timestamptz` as ISO with Z; `timestamp` (no zone) as sent, no Z; `date` as YYYY-MM-DD; `interval` as text; `bytea` as \\x hex. ' +
      'An error carries Postgres\'s message and code, the table/column/constraint it names, and for parse errors the line, ' +
      'column and text.',
    input: obj({
      sql: { type: 'string', minLength: 1, description: 'the SQL to run' },
      limit: { type: 'integer', minimum: 1, default: 10, description: 'rows to return per statement (default 10); rowCount always says how many there were' },
      maxCellChars: { type: 'integer', minimum: 1, default: 1000, description: 'longest cell returned whole (default 1000); longer ones end in …[truncated, N chars]' },
      params: { type: 'array', description: 'values for $1…$n; single statement only' },
    }, ['sql']),
    mutates: true, agents: ['coding'], offered: enabled,
    async execute(ctx, a) {
      if (!ctx.app.databases) throw refusal('database_unavailable', 'this server has no agent database wiring');
      if (!(await ctx.app.settings.resolve('agent_database', { project: ctx.project }))) {
        throw refusal('database_off', 'agent_database is off for this project');
      }
      try {
        const results = await ctx.app.databases.query(ctx.project.id, String(a.sql), {
          limit: Number(a.limit ?? 10), maxCellChars: Number(a.maxCellChars ?? 1000), params: a.params as unknown[] | undefined,
        });
        return { results };
      } catch (e) {
        if (e instanceof SqlError) throw refusal('sql_error', e.message, { ...e.info, rolledBack: 'nothing in this call was applied' });
        throw e;
      }
    },
  },
];
