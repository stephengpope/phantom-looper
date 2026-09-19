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

/** Postgres refused the agent's SQL. The message is Postgres's own — the
 *  agent needs it verbatim to fix the statement. */
export class SqlError extends Error {
  constructor(message: string, readonly detail?: string, readonly hint?: string, readonly position?: string) {
    super(message);
  }
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

  /** Run the agent's SQL — any number of statements — connected AS the
   *  workspace role, in that workspace's database. One result per statement,
   *  carrying the first `limit` rows and the true row count. Rows are read as
   *  they stream and dropped past `limit`, so the server never holds a
   *  result bigger than what was asked for. */
  async query(workspaceId: string, sql: string, limit: number): Promise<StatementResult[]> {
    await this.ensure(workspaceId);
    const client = new pg.Client({ connectionString: this.connectionString(workspaceId), connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      // No parameters => the simple query protocol, which is what allows
      // several statements in one text. A `row` listener makes pg hand each
      // row over instead of accumulating it; the result object identifies
      // which statement the row belongs to.
      const kept = new Map<pg.Result, Record<string, unknown>[]>();
      const results = await new Promise<pg.Result[]>((resolve, reject) => {
        const q = new pg.Query(sql);
        q.on('row', (row, result) => {
          if (!result) return;
          const rows = kept.get(result) ?? [];
          if (rows.length < limit) rows.push(row as Record<string, unknown>);
          kept.set(result, rows);
        });
        q.on('end', (r) => resolve(Array.isArray(r) ? r : [r]));
        q.on('error', reject);
        client.query(q);
      });
      return results.map((r) => ({ command: r.command, rowCount: r.rowCount, rows: kept.get(r) ?? [] }));
    } catch (e) {
      const pe = e as { message: string; detail?: string; hint?: string; position?: string; code?: string };
      // Postgres errors carry a SQLSTATE; anything else (connection) is ours.
      if (!pe.code) throw e;
      throw new SqlError(pe.message, pe.detail, pe.hint, pe.position);
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
