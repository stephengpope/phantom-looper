// Database — the roles, the Postgres pool, drizzle over it, and the
// migration runner.
//
// One role per job, least privilege (the only superuser connection is the
// boot's own, closed before anything serves):
//
//   superuser   Docker's bootstrap user (DATABASE_URL). Boot only: makes
//               sure the two roles below exist with current passwords and
//               grants, then hangs up. The database console connects as it.
//   migrator    owns every schema and table; the only role that may create,
//               alter or drop one. Each migration set runs on its own
//               short-lived connection as it.
//   backend     the running process — SDK code and user space code, one
//               pool. Reads and writes rows; creates and drops agent
//               play-space databases and roles; cannot alter a table.
//   authenticated  SQL handed to something that is not the backend's own
//               code — a user's query, an agent's tool — run by `queryAs`
//               inside a transaction that names the caller's organization
//               and user; Postgres's row-level policies (migration 057) do
//               the fencing. Rows only, through policies; no table owned.
//   project_<id> an agent's play space, everything inside its own database
//               (AgentDatabases).
//
// The two passwords are derived from ENCRYPTION_KEY (lib/crypto
// derivedPassword), the same way every play-space role's is: stored
// nowhere, re-set on every boot.
//
// Migrations are plain SQL files applied in name order, each in its own
// transaction, recorded in a ledger table. Two sets run at boot: the SDK's
// (shipped in this package under migrations/) and the app's
// (config.migrations), each with its own ledger, so the two never
// interleave and the SDK's can ship on its own.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { derivedPassword } from '../lib/crypto.js';
import { logger } from '../lib/log.js';
import { AGENT_TYPES, runStatements, type QueryOptions, type StatementResult } from './sqlRunner.js';
import type { Caller } from '../identity/Identity.js';

const log = logger('database');

export type Drizzle = ReturnType<typeof drizzle<typeof schema>>;
/** The handle inside `transaction(async (tx) => …)` — an owner's method
 *  takes it when a caller needs the write inside ITS transaction. */
export type Transaction = Parameters<Parameters<Drizzle['transaction']>[0]>[0];

/** One folder of SQL files and the schema whose `schema_migrations` table
 *  records which of them ran. `ledgerMovedFrom`: the schema the ledger lived
 *  in before — found there and not yet at `ledgerSchema`, it is moved first,
 *  so the files already applied stay applied. */
export interface MigrationSet { dir: string; ledgerSchema: string; ledgerMovedFrom?: string }

/** The SDK's own migrations, shipped beside this package's src/dist. */
export const SDK_MIGRATIONS: MigrationSet = {
  dir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations'),
  ledgerSchema: 'phantom_agent_sdk',
  // The ledger lived in public from the first install until the schema
  // split (054); an install from before finds it there.
  ledgerMovedFrom: 'public',
};

export const MIGRATOR_ROLE = 'migrator';
export const BACKEND_ROLE = 'backend';
export const AUTHENTICATED_ROLE = 'authenticated';

/** The transaction settings the policies read (migration 057). */
export const ORGANIZATION_SETTING = 'phantom.organization_id';
export const USER_SETTING = 'phantom.user_id';
const QUERY_AS_STATEMENT_TIMEOUT = '30s';

/** Postgres's own schemas, never ours to own. `public` is the database
 *  owner's and stays so; a table of ours found in it (the ledger, before
 *  054 moved it) is still handed over. */
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

export class Database {
  private constructor(
    readonly pool: pg.Pool,
    readonly drizzle: Drizzle,
    /** The `backend` role's connection string — what the pool is on. */
    readonly url: string,
    private readonly migratorUrl: string,
    private readonly authenticatedUrl: string,
  ) {}

  /** Boot. As the bootstrap superuser: the `migrator` and `backend` roles
   *  exist with this key's passwords and their grants (idempotent, heals
   *  a rotated key and an install from before the split). Then the
   *  superuser connection closes and the pool opens as `backend`. Nothing
   *  is migrated yet. */
  static async open(superuserUrl: string, encryptionKey: Buffer): Promise<Database> {
    const migratorUrl = withRole(superuserUrl, MIGRATOR_ROLE, derivedPassword(encryptionKey, `role:${MIGRATOR_ROLE}`));
    const backendUrl = withRole(superuserUrl, BACKEND_ROLE, derivedPassword(encryptionKey, `role:${BACKEND_ROLE}`));
    const authenticatedUrl = withRole(superuserUrl, AUTHENTICATED_ROLE, derivedPassword(encryptionKey, `role:${AUTHENTICATED_ROLE}`));
    const superuser = new pg.Client({ connectionString: superuserUrl });
    await superuser.connect();
    try {
      await ensureRoles(superuser, { migrator: new URL(migratorUrl).password, backend: new URL(backendUrl).password,
        authenticated: new URL(authenticatedUrl).password });
    } finally {
      await superuser.end();
    }
    const pool = new pg.Pool({ connectionString: backendUrl });
    return new Database(pool, drizzle(pool, { schema }), backendUrl, migratorUrl, authenticatedUrl);
  }

  /** Apply every unapplied file of the set, in name order, each in its own
   *  transaction, on one connection as `migrator` that closes after.
   *  `upTo` stops after the named file (inclusive) so a migration can be
   *  tried against the state that preceded it. */
  async migrate(set: MigrationSet, options: { upTo?: string } = {}): Promise<string[]> {
    const client = new pg.Client({ connectionString: this.migratorUrl });
    await client.connect();
    try {
      return await runMigrations(client, set, options);
    } finally {
      await client.end();
    }
  }

  /** A caller's own SQL on this database, fenced by Postgres: one
   *  connection as `authenticated`, one transaction that names the
   *  caller's organization and user for the row-level policies (057), the
   *  statements, commit — an error undoes the whole call. The phantom admin
   *  runs as `backend` (no policies, as every SDK read). Only a user has
   *  rows to see; a user with no organization sees none. */
  async queryAs(caller: Caller, sql: string, options: QueryOptions): Promise<StatementResult[]> {
    const client = new pg.Client({ connectionString: caller.type === 'phantom_admin' ? this.url : this.authenticatedUrl,
      connectionTimeoutMillis: 5000, types: AGENT_TYPES });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(`set local statement_timeout = ${quoteLiteral(QUERY_AS_STATEMENT_TIMEOUT)}`);
      if (caller.type === 'user') {
        await client.query('select set_config($1, $2, true), set_config($3, $4, true)',
          [ORGANIZATION_SETTING, caller.organization.id, USER_SETTING, caller.user.id]);
      }
      const results = await runStatements(client, sql, options);
      await client.query('commit');
      return results;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      await client.end().catch(() => {});
    }
  }

  /** Run `fn` inside one transaction. */
  transaction<T>(body: (transaction: Transaction) => Promise<T>): Promise<T> {
    return this.drizzle.transaction(body);
  }

  /** Postgres raised a unique constraint (23505): the row's owner turns it
   *  into its own refusal instead of letting it 500. */
  static isUniqueViolation(error: unknown): boolean {
    return (error as { code?: string } | null)?.code === '23505';
  }

  async close(): Promise<void> { await this.pool.end(); }
}

/** The same server and database, another role. */
function withRole(url: string, role: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  return parsed.toString();
}

/** The two roles, their passwords, and what each may do — in the database
 *  the superuser connection is on. Everything here is a no-op the second
 *  time, except the password set (a rotated key). */
async function ensureRoles(superuser: pg.Client, passwords: { migrator: string; backend: string; authenticated: string }): Promise<void> {
  const { rows: [{ datname }] } = await superuser.query<{ datname: string }>('select current_database() as datname');
  const database = quoteIdent(datname);
  const migrator = quoteIdent(MIGRATOR_ROLE);
  const backend = quoteIdent(BACKEND_ROLE);
  const authenticated = quoteIdent(AUTHENTICATED_ROLE);

  const existing = new Set((await superuser.query<{ rolname: string }>(
    'select rolname from pg_roles where rolname = any($1)', [[MIGRATOR_ROLE, BACKEND_ROLE, AUTHENTICATED_ROLE]])).rows.map((row) => row.rolname));
  const upsertRole = async (name: string, quoted: string, password: string, attributes: string) => {
    if (existing.has(name)) await superuser.query(`alter role ${quoted} with ${attributes} password ${quoteLiteral(password)}`);
    else { await superuser.query(`create role ${quoted} login ${attributes} password ${quoteLiteral(password)}`); log.info({ role: name }, 'role created'); }
  };
  await upsertRole(MIGRATOR_ROLE, migrator, passwords.migrator, 'nosuperuser nocreatedb nocreaterole noinherit');
  // bypassrls: the row-level policies (057) fence `authenticated`, never the backend's own reads and writes.
  await upsertRole(BACKEND_ROLE, backend, passwords.backend, 'nosuperuser createdb createrole noinherit bypassrls');
  await upsertRole(AUTHENTICATED_ROLE, authenticated, passwords.authenticated, 'nosuperuser nocreatedb nocreaterole noinherit nobypassrls');

  // migrator: owns this database's schemas and everything in them, may
  // make new ones. An install from before the split has them owned by the
  // superuser — hand them over, table by table (sequences follow).
  await superuser.query(`grant connect, create, temporary on database ${database} to ${migrator}`);
  const { rows: schemas } = await superuser.query<{ nspname: string }>(
    `select nspname from pg_namespace where nspname <> all($1) and nspname not like 'pg_%'`, [SYSTEM_SCHEMAS]);
  for (const { nspname } of schemas) {
    const schemaName = quoteIdent(nspname);
    if (nspname !== 'public') await superuser.query(`alter schema ${schemaName} owner to ${migrator}`);
    const { rows: tables } = await superuser.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm') and c.relowner <> (select oid from pg_roles where rolname = $2)`,
      [nspname, MIGRATOR_ROLE]);
    for (const { relname } of tables) await superuser.query(`alter table ${schemaName}.${quoteIdent(relname)} owner to ${migrator}`);
    const { rows: functions } = await superuser.query<{ signature: string }>(
      `select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1 and p.proowner <> (select oid from pg_roles where rolname = $2)`,
      [nspname, MIGRATOR_ROLE]);
    for (const { signature } of functions) await superuser.query(`alter function ${signature} owner to ${migrator}`);
    // backend and authenticated: the rows in every table that exists now …
    // (authenticated's grants are the door; the policies decide which rows,
    // and a table with none shows it nothing.)
    await superuser.query(`grant usage on schema ${schemaName} to ${backend}, ${authenticated}`);
    await superuser.query(`grant select, insert, update, delete on all tables in schema ${schemaName} to ${backend}, ${authenticated}`);
    await superuser.query(`grant usage, select, update on all sequences in schema ${schemaName} to ${backend}, ${authenticated}`);
  }
  // … and in every table the migrator makes from now on, in any schema.
  await superuser.query(`grant connect on database ${database} to ${backend}, ${authenticated}`);
  await superuser.query(`alter default privileges for role ${migrator} grant usage on schemas to ${backend}, ${authenticated}`);
  await superuser.query(`alter default privileges for role ${migrator} grant select, insert, update, delete on tables to ${backend}, ${authenticated}`);
  await superuser.query(`alter default privileges for role ${migrator} grant usage, select, update on sequences to ${backend}, ${authenticated}`);

  // backend drops a play-space database `with (force)`: ending its open
  // connections takes pg_signal_backend. Play spaces made before the split
  // are the superuser's: their databases become backend's (so it may drop
  // them) and backend gets admin on their roles (so it may re-set a
  // password and drop them). A role backend creates itself carries that
  // admin already.
  await superuser.query(`grant pg_signal_backend to ${backend}`);
  const { rows: playSpaces } = await superuser.query<{ datname: string }>(
    `select datname from pg_database d where datname like 'project\\_%' and d.datdba <> (select oid from pg_roles where rolname = $1)`, [BACKEND_ROLE]);
  for (const { datname: name } of playSpaces) await superuser.query(`alter database ${quoteIdent(name)} owner to ${backend}`);
  const { rows: playRoles } = await superuser.query<{ rolname: string }>(
    `select r.rolname from pg_roles r where r.rolname like 'project\\_%'
       and not exists (select from pg_auth_members m where m.roleid = r.oid and m.member = (select oid from pg_roles where rolname = $1) and m.admin_option)`,
    [BACKEND_ROLE]);
  for (const { rolname } of playRoles) await superuser.query(`grant ${quoteIdent(rolname)} to ${backend} with admin option, inherit false, set false`);
  if (playSpaces.length || playRoles.length) log.info({ databases: playSpaces.length, roles: playRoles.length }, 'play spaces handed to the backend role');
}

async function runMigrations(client: pg.Client, set: MigrationSet, options: { upTo?: string }): Promise<string[]> {
  const ledger = `${quoteIdent(set.ledgerSchema)}.schema_migrations`;
  await client.query(`create schema if not exists ${quoteIdent(set.ledgerSchema)}`);
  if (set.ledgerMovedFrom) {
    const [here, there] = await Promise.all([
      client.query('select to_regclass($1) as oid', [`${set.ledgerSchema}.schema_migrations`]),
      client.query('select to_regclass($1) as oid', [`${set.ledgerMovedFrom}.schema_migrations`]),
    ]);
    if (!here.rows[0].oid && there.rows[0].oid) {
      await client.query(`alter table ${quoteIdent(set.ledgerMovedFrom)}.schema_migrations set schema ${quoteIdent(set.ledgerSchema)}`);
    }
  }
  await client.query(`create table if not exists ${ledger} (name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set((await client.query(`select name from ${ledger}`)).rows.map((row: { name: string }) => row.name));
  const files = (await fs.readdir(set.dir)).filter((file) => file.endsWith('.sql')).sort()
    .filter((file) => !options.upTo || file <= options.upTo);
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(set.dir, file), 'utf8');
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query(`insert into ${ledger} (name) values ($1)`, [file]);
      await client.query('commit');
      ran.push(file);
    } catch (error) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }
  return ran;
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
