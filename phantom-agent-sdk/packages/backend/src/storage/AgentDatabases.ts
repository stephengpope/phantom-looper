// The agent's own database, one per project: `project_<id>` on the same
// Postgres server this API runs on, reached ONLY through the coding agent's
// database_query tool (the /projects/:id/database routes). It is the
// agent's private, permanent store — nothing of ours lives in it, the
// project's code cannot reach it, and it outlives containers and sessions.
//
// The fence is a LOGIN role, `project_<id>`, and every query CONNECTS as
// it: `set role` inside a superuser connection is no fence at all (the
// statement text is the agent's, and `reset role` is one statement). The
// role owns nothing above its database — no createdb, no createrole — and
// the database's owner is our own user, so the agent cannot drop it. Its
// password is derived from ENCRYPTION_KEY and the project id: stored
// nowhere, re-set on every ensure (so a rotated key heals itself), and it
// never leaves this process.
//
// The setting `agent_database` says whether a project HAS this; the route
// reads it. Off keeps the data; only the project going drops it.
import pg from 'pg';
import { parse as parseArray } from 'postgres-array';
import { logger } from '../lib/log.js';
import { derivedPassword } from '../lib/crypto.js';

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
const asIs = (value: string) => value;
/** A number when exact, the digits otherwise — never a wrong number. */
const bigint = (value: string) => { const b = BigInt(value); return b <= SAFE && b >= -SAFE ? Number(b) : value; };
const TYPES = pg.types.builtins;
// element OID -> [parser, array OID]. Postgres's text is kept where the
// driver's parse would add a claim the value never made (a zone) or a shape
// nobody asked for.
const OVERRIDES: Record<number, [(value: string) => unknown, number]> = {
  [TYPES.INT8]: [bigint, 1016],
  [TYPES.DATE]: [asIs, 1182],       // YYYY-MM-DD
  [TYPES.BYTEA]: [asIs, 1001],      // \x hex
  [TYPES.TIMESTAMP]: [asIs, 1115],  // no zone, so no Z: "2026-09-19 20:11:51.051"
  [TYPES.INTERVAL]: [asIs, 1187],   // "1 day 02:00:00"
};
const ARRAY_OF = Object.fromEntries(Object.entries(OVERRIDES).map(([oid, [parse, arr]]) => [arr, parse])) as
  Record<number, (value: string) => unknown>;
const AGENT_TYPES: pg.CustomTypesConfig = {
  getTypeParser: (oid, format) => {
    if (format === 'binary') return pg.types.getTypeParser(oid, format);
    if (OVERRIDES[oid]) return OVERRIDES[oid][0];
    const elementParser = ARRAY_OF[oid];
    if (elementParser) return (text: string) => parseArray(text, elementParser);
    return pg.types.getTypeParser(oid, format);
  },
};

/** The cell the agent sees: strings past the cap end in the true length. */
function cell(value: unknown, maxCellChars: number): unknown {
  if (typeof value === 'string' && value.length > maxCellChars) return `${value.slice(0, maxCellChars)}…[truncated, ${value.length} chars]`;
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const json = JSON.stringify(value);
    if (json.length > maxCellChars) return `${json.slice(0, maxCellChars)}…[truncated, ${json.length} chars]`;
  }
  return value;
}

const quoteIdent = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const quoteLiteral = (literal: string) => `'${literal.replaceAll("'", "''")}'`;

export class AgentDatabases {
  /** Projects whose database and role this process has already ensured. */
  private ready = new Set<string>();
  private ensuring = new Map<string, Promise<void>>();
  private readonly server: URL;

  /** `pool` is the backend's own connection (the `backend` role: createdb,
   *  createrole — Database.open) — the one that creates databases and
   *  roles. `databaseUrl` is that role's; a project's connection is the
   *  same host and port with its own role and database. */
  constructor(private readonly pool: pg.Pool, databaseUrl: string, private readonly encryptionKey: Buffer) {
    this.server = new URL(databaseUrl);
  }

  /** Database name and role name are the same word: `project_<id>`. A
   *  project id is a lowercase ULID, so the name is a plain identifier. */
  nameOf(projectId: string): string { return `project_${projectId}`; }

  private passwordOf(projectId: string): string { return derivedPassword(this.encryptionKey, `database:${projectId}`); }

  /** The connection string the project's code gets as AGENT_DATABASE_URL
   *  when `agent_database_shared` is on — the same role and database the
   *  tool uses. Ensures first, so the URL works the moment it is handed out.
   *  The host is the server's own (`postgres` on the stack network); the
   *  container must be on that network to resolve it. */
  async urlFor(projectId: string): Promise<string> {
    await this.ensure(projectId);
    return this.connectionString(projectId);
  }

  private connectionString(projectId: string): string {
    const url = new URL(this.server.toString());
    url.username = this.nameOf(projectId);
    url.password = this.passwordOf(projectId);
    url.pathname = `/${this.nameOf(projectId)}`;
    return url.toString();
  }

  /** The role and database exist and the role's password is current. Once
   *  per project per process; serialized so two first queries cannot race
   *  each other into `create role` twice. */
  async ensure(projectId: string): Promise<void> {
    if (this.ready.has(projectId)) return;
    const inflight = this.ensuring.get(projectId);
    if (inflight) return inflight;
    const ensuring = this.ensureInner(projectId)
      .then(() => { this.ready.add(projectId); })
      .finally(() => this.ensuring.delete(projectId));
    this.ensuring.set(projectId, ensuring);
    return ensuring;
  }

  private async ensureInner(projectId: string): Promise<void> {
    const name = this.nameOf(projectId);
    const role = quoteIdent(name);
    const password = quoteLiteral(this.passwordOf(projectId));

    const { rows: roles } = await this.pool.query('select from pg_roles where rolname = $1', [name]);
    if (!roles.length) {
      await this.pool.query(`create role ${role} login nosuperuser nocreatedb nocreaterole noinherit password ${password}`);
    } else {
      await this.pool.query(`alter role ${role} with password ${password}`);
    }
    await this.pool.query(`alter role ${role} set statement_timeout = ${quoteLiteral(STATEMENT_TIMEOUT)}`);

    const { rows: dbs } = await this.pool.query('select from pg_database where datname = $1', [name]);
    if (!dbs.length) {
      // Owned by the backend role (the agent cannot drop it); private
      // (nobody but its role may connect); the role may build anything
      // inside it.
      await this.pool.query(`create database ${role}`);
      await this.pool.query(`revoke connect on database ${role} from public`);
      await this.pool.query(`grant connect, create, temporary on database ${role} to ${role}`);
      // Schema grants live inside the database: one connection to it as
      // its owner, at creation only.
      const admin = new URL(this.server.toString());
      admin.pathname = `/${name}`;
      const client = new pg.Client({ connectionString: admin.toString() });
      await client.connect();
      try {
        await client.query(`grant all on schema public to ${role}`);
      } finally {
        await client.end();
      }
      log.info({ project: projectId, database: name }, 'agent database created');
    }
  }

  /** Run the agent's SQL connected AS the project role, in that
   *  project's database. One result per statement, carrying the first
   *  `limit` rows and the true row count. Rows are read as they stream and
   *  dropped past `limit`, so the server never holds a result bigger than
   *  what was asked for. Rows come back as arrays with the field list, so a
   *  duplicate column name is refused instead of silently overwriting. */
  async query(projectId: string, sql: string, options: QueryOptions): Promise<StatementResult[]> {
    await this.ensure(projectId);
    const client = new pg.Client({
      connectionString: this.connectionString(projectId), connectionTimeoutMillis: 5000, types: AGENT_TYPES,
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
        const config: pg.QueryArrayConfig = { text: sql, values: options.params, rowMode: 'array' };
        const query = new pg.Query(config);
        query.on('row', (row, result) => {
          if (!result) return;
          const rows = kept.get(result) ?? [];
          if (rows.length < options.limit) rows.push(row as unknown[]);
          kept.set(result, rows);
        });
        query.on('end', (results) => resolve(Array.isArray(results) ? results : [results]));
        query.on('error', reject);
        client.query(query);
      });
      return results.map((result) => {
        const names = result.fields.map((field) => field.name);
        const dup = names.find((name, i) => names.indexOf(name) !== i);
        if (dup) throw new SqlError(`duplicate column name "${dup}" — alias one of them so both values come back`, {});
        const rows = (kept.get(result) ?? []).map((row) =>
          Object.fromEntries(names.map((name, i) => [name, cell(row[i], options.maxCellChars)])));
        return { command: result.command, rowCount: result.rowCount, rows };
      });
    } catch (error) {
      if (error instanceof SqlError) throw error;
      const pgError = error as { message: string; code?: string; detail?: string; hint?: string; position?: string;
        table?: string; column?: string; constraint?: string };
      // Postgres errors carry a SQLSTATE; anything else (connection) is ours.
      if (!pgError.code) throw error;
      throw new SqlError(pgError.message, {
        code: pgError.code, detail: pgError.detail, hint: pgError.hint,
        table: pgError.table, column: pgError.column, constraint: pgError.constraint,
        at: pgError.position ? locate(sql, pgError.position) : undefined,
      });
    } finally {
      await client.end().catch(() => {});
    }
  }

  /** The project is gone: its database and role go with it. `force` ends
   *  any open connection first. */
  async drop(projectId: string): Promise<void> {
    const name = this.nameOf(projectId);
    this.ready.delete(projectId);
    await this.pool.query(`drop database if exists ${quoteIdent(name)} with (force)`);
    await this.pool.query(`drop role if exists ${quoteIdent(name)}`);
    log.info({ project: projectId, database: name }, 'agent database dropped');
  }
}
