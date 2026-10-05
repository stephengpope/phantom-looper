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
import { logger } from '../lib/log.js';
import { AGENT_TYPES, runStatements, type QueryOptions, type StatementResult } from './sqlRunner.js';
export { SqlError, locate, type QueryOptions, type StatementResult, type SqlErrorLocation } from './sqlRunner.js';
import { derivedPassword } from '../lib/crypto.js';

const log = logger('database');

const STATEMENT_TIMEOUT = '30s';

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
      return await runStatements(client, sql, options);
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
