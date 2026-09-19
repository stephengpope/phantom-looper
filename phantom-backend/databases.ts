// The agent's own database, one per workspace: `workspace_<id>` on the same
// Postgres server this API runs on, reached ONLY through the coding agent's
// database_query tool (the /workspaces/:id/database routes). It is the
// agent's private, permanent store — nothing of ours lives in it, the
// project's code cannot reach it, and it outlives containers and sessions.
//
// The fence is a LOGIN role, `workspace_<id>`, and every query CONNECTS as
// it: `set role` inside a superuser connection is no fence at all (the
// statement text is the agent's, and `reset role` is one statement). The
// role owns nothing above its database — no createdb, no createrole — and
// the database's owner is our own user, so the agent cannot drop it. Its
// password is derived from ENCRYPTION_KEY and the workspace id: stored
// nowhere, re-set on every ensure (so a rotated key heals itself), and it
// never leaves this process.
//
// The setting `agent_database` says whether a workspace HAS this; the route
// reads it. Off keeps the data; only the workspace going drops it.
import { createHmac } from 'node:crypto';
import pg from 'pg';
import { parse as parseArray } from 'postgres-array';
import { logger } from './log.js';

const log = logger('database');

const STATEMENT_TIMEOUT = '30s';

export interface StatementResult {
  /** Postgres's command tag: SELECT, INSERT, CREATE TABLE, ... */
  command: string;
  /** The TRUE count Postgres reports for the statement — every row a select
   *  matched, or every row a write touched — whatever `rows` carries. */
  rowCount: number | null;
  /** The first `limit` rows the agent asked for. */
  rows: Record<string, unknown>[];
}

/** What the agent asks for, per call. */
export interface QueryOptions {
  /** Rows returned per statement; rowCount is always the true total. */
  limit: number;
  /** Longest cell kept whole; past it the cell ends in `…[truncated, N chars]`. */
  maxCellChars: number;
  /** Values for $1…$n. Postgres allows them with ONE statement only. */
  params?: unknown[];
}

/** Where a statement failed, when Postgres says (parse errors do; runtime
 *  errors name the object instead — see SqlError). */
export interface SqlErrorLocation { line: number; column: number; text: string }

/** Postgres refused the agent's SQL. The message is Postgres's own — the
 *  agent needs it verbatim to fix the statement. The call was ONE transaction,
 *  so nothing in it was applied. */
export class SqlError extends Error {
  constructor(message: string, readonly info: {
    code?: string; detail?: string; hint?: string;
    table?: string; column?: string; constraint?: string;
    at?: SqlErrorLocation;
  }) {
    super(message);
  }
}

/** A 1-based character offset (Postgres's `position`) as line, column and
 *  the line's text. */
export function locate(sql: string, position: string): SqlErrorLocation {
  const offset = Math.max(0, Number(position) - 1);
  const before = sql.slice(0, offset);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = sql.indexOf('\n', offset);
  return { line, column: offset - lineStart + 1, text: sql.slice(lineStart, lineEnd < 0 ? undefined : lineEnd) };
}

/** How values come back to the agent — the driver's defaults leak Node
 *  shapes (bigint as string, date and zoneless timestamp as a Z-stamped
 *  timestamp, bytea as a Buffer object, interval as an object). Each
 *  override applies to the type's array too. Scoped to the agent's
 *  connection: our own pool keeps its own. */
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const asIs = (v: string) => v;
/** A number when exact, the digits otherwise — never a wrong number. */
const bigint = (v: string) => { const b = BigInt(v); return b <= SAFE && b >= -SAFE ? Number(b) : v; };
const T = pg.types.builtins;
// element OID -> [parser, array OID]. Postgres's text is kept where the
// driver's parse would add a claim the value never made (a zone) or a shape
// nobody asked for.
const OVERRIDES: Record<number, [(v: string) => unknown, number]> = {
  [T.INT8]: [bigint, 1016],
  [T.DATE]: [asIs, 1182],       // YYYY-MM-DD
  [T.BYTEA]: [asIs, 1001],      // \x hex
  [T.TIMESTAMP]: [asIs, 1115],  // no zone, so no Z: "2026-09-19 20:11:51.051"
  [T.INTERVAL]: [asIs, 1187],   // "1 day 02:00:00"
};
const ARRAY_OF = Object.fromEntries(Object.entries(OVERRIDES).map(([oid, [parse, arr]]) => [arr, parse])) as
  Record<number, (v: string) => unknown>;
const AGENT_TYPES: pg.CustomTypesConfig = {
  getTypeParser: (oid, format) => {
    if (format === 'binary') return pg.types.getTypeParser(oid, format);
    if (OVERRIDES[oid]) return OVERRIDES[oid][0];
    if (ARRAY_OF[oid]) return (v: string) => parseArray(v, ARRAY_OF[oid]);
    return pg.types.getTypeParser(oid, format);
  },
};

/** The cell the agent sees: strings past the cap end in the true length. */
function cell(v: unknown, maxCellChars: number): unknown {
  if (typeof v === 'string' && v.length > maxCellChars) return `${v.slice(0, maxCellChars)}…[truncated, ${v.length} chars]`;
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
    const s = JSON.stringify(v);
    if (s.length > maxCellChars) return `${s.slice(0, maxCellChars)}…[truncated, ${s.length} chars]`;
  }
  return v;
}

const quoteIdent = (s: string) => `"${s.replaceAll('"', '""')}"`;
const quoteLiteral = (s: string) => `'${s.replaceAll("'", "''")}'`;

export class Databases {
  /** Workspaces whose database and role this process has already ensured. */
  private ready = new Set<string>();
  private ensuring = new Map<string, Promise<void>>();
  private readonly server: URL;

  /** `pool` is the API's own (superuser) connection — the one that creates
   *  databases and roles. `databaseUrl` names the server; a workspace's
   *  connection is the same host and port with its own role and database. */
  constructor(private readonly pool: pg.Pool, databaseUrl: string, private readonly encryptionKey: Buffer) {
    this.server = new URL(databaseUrl);
  }

  /** Database name and role name are the same word: `workspace_<id>`. A
   *  workspace id is a lowercase ULID, so the name is a plain identifier. */
  nameOf(workspaceId: string): string { return `workspace_${workspaceId}`; }

  private passwordOf(workspaceId: string): string {
    return createHmac('sha256', this.encryptionKey).update(`database:${workspaceId}`).digest('base64url');
  }

  private connectionString(workspaceId: string): string {
    const u = new URL(this.server.toString());
    u.username = this.nameOf(workspaceId);
    u.password = this.passwordOf(workspaceId);
    u.pathname = `/${this.nameOf(workspaceId)}`;
    return u.toString();
  }

  /** The role and database exist and the role's password is current. Once
   *  per workspace per process; serialized so two first queries cannot race
   *  each other into `create role` twice. */
  async ensure(workspaceId: string): Promise<void> {
    if (this.ready.has(workspaceId)) return;
    const inflight = this.ensuring.get(workspaceId);
    if (inflight) return inflight;
    const p = this.ensureInner(workspaceId)
      .then(() => { this.ready.add(workspaceId); })
      .finally(() => this.ensuring.delete(workspaceId));
    this.ensuring.set(workspaceId, p);
    return p;
  }

  private async ensureInner(workspaceId: string): Promise<void> {
    const name = this.nameOf(workspaceId);
    const role = quoteIdent(name);
    const password = quoteLiteral(this.passwordOf(workspaceId));

    const { rows: roles } = await this.pool.query('select from pg_roles where rolname = $1', [name]);
    if (!roles.length) {
      await this.pool.query(`create role ${role} login nosuperuser nocreatedb nocreaterole noinherit password ${password}`);
    } else {
      await this.pool.query(`alter role ${role} with password ${password}`);
    }
    await this.pool.query(`alter role ${role} set statement_timeout = ${quoteLiteral(STATEMENT_TIMEOUT)}`);

    const { rows: dbs } = await this.pool.query('select from pg_database where datname = $1', [name]);
    if (!dbs.length) {
      // Owned by our user (the agent cannot drop it); private (nobody but
      // its role may connect); the role may build anything inside it.
      await this.pool.query(`create database ${role}`);
      await this.pool.query(`revoke connect on database ${role} from public`);
      await this.pool.query(`grant connect, create, temporary on database ${role} to ${role}`);
      // Schema grants live inside the database: one superuser connection to
      // it, at creation only.
      const admin = new URL(this.server.toString());
      admin.pathname = `/${name}`;
      const client = new pg.Client({ connectionString: admin.toString() });
      await client.connect();
      try {
        await client.query(`grant all on schema public to ${role}`);
      } finally {
        await client.end();
      }
      log.info({ workspace: workspaceId, database: name }, 'agent database created');
    }
  }

  /** Run the agent's SQL connected AS the workspace role, in that
   *  workspace's database. One result per statement, carrying the first
   *  `limit` rows and the true row count. Rows are read as they stream and
   *  dropped past `limit`, so the server never holds a result bigger than
   *  what was asked for. Rows come back as arrays with the field list, so a
   *  duplicate column name is refused instead of silently overwriting. */
  async query(workspaceId: string, sql: string, o: QueryOptions): Promise<StatementResult[]> {
    await this.ensure(workspaceId);
    const client = new pg.Client({
      connectionString: this.connectionString(workspaceId), connectionTimeoutMillis: 5000, types: AGENT_TYPES,
    });
    await client.connect();
    try {
      // No parameters => the simple query protocol, which is what allows
      // several statements in one text (one implicit transaction). With
      // parameters Postgres takes exactly one statement. A `row` listener
      // makes pg hand each row over instead of accumulating it; the result
      // object identifies which statement the row belongs to.
      const kept = new Map<pg.Result, unknown[][]>();
      const results = await new Promise<pg.Result[]>((resolve, reject) => {
        const config: pg.QueryArrayConfig = { text: sql, values: o.params, rowMode: 'array' };
        const q = new pg.Query(config);
        q.on('row', (row, result) => {
          if (!result) return;
          const rows = kept.get(result) ?? [];
          if (rows.length < o.limit) rows.push(row as unknown[]);
          kept.set(result, rows);
        });
        q.on('end', (r) => resolve(Array.isArray(r) ? r : [r]));
        q.on('error', reject);
        client.query(q);
      });
      return results.map((r) => {
        const names = r.fields.map((f) => f.name);
        const dup = names.find((n, i) => names.indexOf(n) !== i);
        if (dup) throw new SqlError(`duplicate column name "${dup}" — alias one of them so both values come back`, {});
        const rows = (kept.get(r) ?? []).map((row) =>
          Object.fromEntries(names.map((n, i) => [n, cell(row[i], o.maxCellChars)])));
        return { command: r.command, rowCount: r.rowCount, rows };
      });
    } catch (e) {
      if (e instanceof SqlError) throw e;
      const pe = e as { message: string; code?: string; detail?: string; hint?: string; position?: string;
        table?: string; column?: string; constraint?: string };
      // Postgres errors carry a SQLSTATE; anything else (connection) is ours.
      if (!pe.code) throw e;
      throw new SqlError(pe.message, {
        code: pe.code, detail: pe.detail, hint: pe.hint,
        table: pe.table, column: pe.column, constraint: pe.constraint,
        at: pe.position ? locate(sql, pe.position) : undefined,
      });
    } finally {
      await client.end().catch(() => {});
    }
  }

  /** The workspace is gone: its database and role go with it. `force` ends
   *  any open connection first. */
  async drop(workspaceId: string): Promise<void> {
    const name = this.nameOf(workspaceId);
    this.ready.delete(workspaceId);
    await this.pool.query(`drop database if exists ${quoteIdent(name)} with (force)`);
    await this.pool.query(`drop role if exists ${quoteIdent(name)}`);
    log.info({ workspace: workspaceId, database: name }, 'agent database dropped');
  }
}
