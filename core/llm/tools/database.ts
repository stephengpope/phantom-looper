/**
 * The DATABASE kit — `database_query`, the coding agent's door to its own
 * Postgres database for the workspace (the /workspaces/:id/database routes).
 * Workspace-bound like the secrets kit. The tool is THERE when the
 * workspace's `agent_database` setting is on and NOT there when it is off —
 * the factory asks the server. A server that cannot answer is an error, not
 * a missing tool: a silently missing tool is how an agent loses a capability
 * without anyone noticing (workspace.ts's rule). The server checks the
 * setting again on every query — the kit is a convenience, the route is the
 * rule.
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod';

export interface DatabaseToolsConfig {
  baseUrl: string;
  apiKey: string;
  /** The session's workspace — the database is that workspace's. */
  workspaceId: string;
  fetch?: typeof fetch;
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; detail?: unknown } };

export async function databaseTools(cfg: DatabaseToolsConfig): Promise<Record<string, Tool>> {
  const f = cfg.fetch ?? fetch;
  const base = `${cfg.baseUrl}/workspaces/${encodeURIComponent(cfg.workspaceId)}/database`;
  const headers = { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' };

  const res = await f(base, { headers });
  if (!res.ok) throw new Error(`could not read the agent database setting from phantom-backend at ${cfg.baseUrl}: HTTP ${res.status}`);
  const status = await res.json() as Envelope<{ enabled: boolean }>;
  if (!status.ok) throw new Error(`could not read the agent database setting: ${status.error.message}`);
  if (!status.data.enabled) return {};

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
      execute: async ({ sql, limit, maxCellChars, params }) => {
        const r = await f(`${base}/query`, { method: 'POST', headers, body: JSON.stringify({ sql, limit, maxCellChars, params }) });
        const j = await r.json() as Envelope<{ results: unknown[] }>;
        return j.ok ? { results: j.data.results } : j;
      },
    }),
  };
}
