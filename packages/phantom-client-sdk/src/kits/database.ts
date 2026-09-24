// The DATABASE kit — database_query: the agent's own Postgres database for
// the workspace. There when the workspace's `agent_database` is on, absent
// when off — the server says which; a server that cannot answer is an
// error, never a silently missing tool.
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { call, callRaw } from '../backend.js';
import { PhantomError } from '../errors.js';
import type { ToolKit, ToolKitContext } from '../toolkit.js';

export const databaseToolKit: ToolKit = {
  name: 'database',
  mutatingToolNames: ['database_query'],
  version: (ctx) => ctx.workspaceId,
  async build(ctx: ToolKitContext): Promise<Record<string, Tool>> {
    const base = `/workspaces/${encodeURIComponent(ctx.workspaceId)}/database`;
    let status: { enabled: boolean };
    try { status = await call(ctx.backend, 'GET', base); }
    catch (e) { throw new PhantomError('tool_build_failed', `could not read the agent database setting: ${(e as Error).message}`, { cause: e }); }
    if (!status.enabled) return {};
    return {
      database_query: tool({
        description: 'Run SQL in your own database. Several statements allowed; they run as ONE transaction — any error ' +
          'undoes the whole call. No state survives between calls (SET, TEMP tables, cursors are gone next call). 30 s limit ' +
          'per statement. `params` fills $1…$n and needs a single statement. Rows: the first `limit` (default 10), `rowCount` ' +
          'is the true total. Cells over `maxCellChars` (default 1000) end in `…[truncated, N chars]`. Duplicate column names ' +
          'are refused — alias them. Values: bigint as a number when exact, else a string; numeric/decimal always a string; ' +
          '`timestamptz` as ISO with Z; `timestamp` (no zone) as sent, no Z; `date` as YYYY-MM-DD; `interval` as text; `bytea` as \\x hex. ' +
          'An error carries Postgres\'s message and code, the table/column/constraint it names, and for parse errors the line, ' +
          'column and text.',
        inputSchema: z.object({
          sql: z.string().min(1).describe('the SQL to run'),
          limit: z.number().int().min(1).default(10).describe('rows to return per statement (default 10); rowCount always says how many there were'),
          maxCellChars: z.number().int().min(1).default(1000).describe('longest cell returned whole (default 1000); longer ones end in …[truncated, N chars]'),
          params: z.array(z.unknown()).optional().describe('values for $1…$n; single statement only'),
        }),
        execute: async (args) => {
          const j = await callRaw<{ results: unknown[] }>(ctx.backend, 'POST', `${base}/query`, args);
          return j.ok ? { results: j.data?.results } : j;
        },
      }),
    };
  },
};
