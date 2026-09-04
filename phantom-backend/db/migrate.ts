// Plain SQL migrations keyed by filename order. Same mechanism the per-workspace
// schemas use (db/workspaceSchema.ts): ordinary SQL, a version table, no
// generator in the loop.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { logger } from '../log.js';

const log = logger('migrate');
// migrations/ sits at the repo root. From SOURCE this file is server/db/
// (two levels down); from the built image it is dist/server/db/ (three).
// Probe both — a wrong guess here is a boot loop (found live: the image
// scanned /app/dist/migrations and died).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = [
  path.join(HERE, '..', '..', 'migrations'),
  path.join(HERE, '..', '..', '..', 'migrations'),
].find((p) => existsSync(p)) ?? path.join(HERE, '..', '..', 'migrations');

/** `upTo` stops after the named file (inclusive) so a migration can be tested
 *  against the state that preceded it. Production always calls this bare. */
export async function migrate(pool: pg.Pool, opts: { upTo?: string } = {}): Promise<void> {
  await pool.query(`create table if not exists public.schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set(
    (await pool.query('select name from public.schema_migrations')).rows.map((r) => r.name),
  );
  const all = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const files = opts.upTo ? all.filter((f) => f <= opts.upTo!) : all;
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into public.schema_migrations (name) values ($1)', [f]);
      await client.query('commit');
      log.info({ migration: f }, 'applied');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }
}
