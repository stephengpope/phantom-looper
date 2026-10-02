// Database — the Postgres pool, drizzle over it, and the migration runner.
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

export type Drizzle = ReturnType<typeof drizzle<typeof schema>>;
/** The handle inside `transaction(async (tx) => …)` — an owner's method
 *  takes it when a caller needs the write inside ITS transaction. */
export type Transaction = Parameters<Parameters<Drizzle['transaction']>[0]>[0];

/** One folder of SQL files and the schema whose `schema_migrations` table
 *  records which of them ran. */
export interface MigrationSet { dir: string; ledgerSchema: string }

/** The SDK's own migrations, shipped beside this package's src/dist. */
export const SDK_MIGRATIONS: MigrationSet = {
  dir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations'),
  // The ledger has lived in public since the first install; it moves to the
  // SDK's schema with the schema split (docs/phantom-agent-sdk-plan.md §3).
  ledgerSchema: 'public',
};

export class Database {
  private constructor(readonly pool: pg.Pool, readonly drizzle: Drizzle) {}

  /** Open the pool against `databaseUrl`. Nothing is migrated yet. */
  static connect(databaseUrl: string): Database {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    return new Database(pool, drizzle(pool, { schema }));
  }

  /** Apply every unapplied file of the set, in name order, each in its own
   *  transaction. `upTo` stops after the named file (inclusive) so a
   *  migration can be tried against the state that preceded it. */
  async migrate(set: MigrationSet, options: { upTo?: string } = {}): Promise<string[]> {
    const ledger = `${quoteIdent(set.ledgerSchema)}.schema_migrations`;
    await this.pool.query(`create schema if not exists ${quoteIdent(set.ledgerSchema)}`);
    await this.pool.query(`create table if not exists ${ledger} (name text primary key, applied_at timestamptz not null default now())`);
    const applied = new Set((await this.pool.query(`select name from ${ledger}`)).rows.map((row: { name: string }) => row.name));
    const files = (await fs.readdir(set.dir)).filter((file) => file.endsWith('.sql')).sort()
      .filter((file) => !options.upTo || file <= options.upTo);
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await fs.readFile(path.join(set.dir, file), 'utf8');
      const client = await this.pool.connect();
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query(`insert into ${ledger} (name) values ($1)`, [file]);
        await client.query('commit');
        ran.push(file);
      } catch (error) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error });
      } finally {
        client.release();
      }
    }
    return ran;
  }

  /** Run `fn` inside one transaction. */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.drizzle.transaction(fn);
  }

  /** Postgres raised a unique constraint (23505): the row's owner turns it
   *  into its own refusal instead of letting it 500. */
  static isUniqueViolation(error: unknown): boolean {
    return (error as { code?: string } | null)?.code === '23505';
  }

  async close(): Promise<void> { await this.pool.end(); }
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;
