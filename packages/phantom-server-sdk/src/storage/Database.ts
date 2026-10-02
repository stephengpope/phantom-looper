// Database — the Postgres pool, drizzle over it, and the migration runner.
// Two schemas: the SDK's (`phantom_agent_sdk`, migrations shipped in this
// package) and the app's (config.migrations), each with its own ledger.
// Stub.
import type pg from 'pg';

export interface MigrationSet { dir: string; schema: string }

export class Database {
  readonly pool!: pg.Pool;
  /** The drizzle instance every table owner queries through. */
  readonly drizzle!: unknown;

  /** Open the pool against `databaseUrl`. Nothing is migrated yet. */
  static async connect(databaseUrl: string): Promise<Database> { throw stub(); }
  /** Apply every unapplied file of `set.dir`, in name order, each in its
   *  own transaction, recorded in `<set.schema>.schema_migrations`. */
  async migrate(set: MigrationSet): Promise<void> { throw stub(); }
  /** Run `fn` inside one transaction; the table owners take the handle. */
  async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> { throw stub(); }
  /** Is this error Postgres' unique-violation (23505)? */
  static isUniqueViolation(error: unknown): boolean { throw stub(); }
  async close(): Promise<void> { throw stub(); }
}
const stub = () => new Error('stub');
