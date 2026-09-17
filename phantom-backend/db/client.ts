import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Db = ReturnType<typeof makeDb>['db'];

/** Postgres raised a unique constraint: the row's owner turns this into its
 *  own refusal (which name, which code) instead of letting it 500. */
export const isUniqueViolation = (e: unknown): boolean => (e as { code?: string } | null)?.code === '23505';

export function makeDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return { pool, db };
}
