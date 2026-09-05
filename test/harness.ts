// Shared test infrastructure. One Postgres container and one workspace image
// for the WHOLE run, not one per suite — starting five databases serially was
// most of the suite's wall-clock.
//
// Reuse is the point: the container is left running between runs (name is
// fixed), so a second `npm test` skips the ~5s boot entirely. Each suite gets
// its own DATABASE inside that one server, so suites stay isolated without
// paying for isolation.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeDb } from '../phantom-backend/db/client.js';
import { migrate } from '../phantom-backend/db/migrate.js';

const PG_NAME = 'phantom-test-pg';
const PG_PORT = 55432;
// The model catalog never reaches models.dev from a test: an address nothing
// listens on fails fast, and the committed snapshot answers (models.ts).
process.env.MODELS_DEV_API_BASE ??= 'http://127.0.0.1:9';

export const FS_IMAGE = 'phantom-test-fs';

function sh(cmd: string, args: string[], opts: { ignore?: boolean } = {}) {
  return execFileSync(cmd, args, { stdio: opts.ignore ? 'ignore' : 'pipe', encoding: 'utf8' });
}

let pgReady: Promise<void> | null = null;

/** Start the shared Postgres once per process; reuse a running one. */
function ensurePostgres(): Promise<void> {
  if (pgReady) return pgReady;
  pgReady = (async () => {
    const running = sh('docker', ['ps', '-q', '-f', `name=^${PG_NAME}$`]).trim();
    if (!running) {
      sh('docker', ['rm', '-f', PG_NAME], { ignore: true });
      sh('docker', ['run', '-d', '--name', PG_NAME, '-p', `${PG_PORT}:5432`,
        '-e', 'POSTGRES_PASSWORD=t', '-e', 'POSTGRES_DB=postgres',
        '--tmpfs', '/var/lib/postgresql/data',  // in-memory: no disk sync, much faster
        'postgres:16-alpine', '-c', 'fsync=off', '-c', 'synchronous_commit=off',
        '-c', 'full_page_writes=off'], { ignore: true });
    }
    const admin = makeDb(`postgres://postgres:t@localhost:${PG_PORT}/postgres`);
    for (let i = 0; ; i++) {
      try { await admin.pool.query('select 1'); break; }
      catch {
        if (i > 120) throw new Error('shared test postgres never came up');
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    await admin.pool.end();
  })();
  return pgReady;
}

/** A fresh database inside the shared server, migrated and ready. */
export async function testDb(suite: string, opts: { upTo?: string } = {}) {
  await ensurePostgres();
  const name = `t_${suite}_${Date.now().toString(36)}`;
  const admin = makeDb(`postgres://postgres:t@localhost:${PG_PORT}/postgres`);
  await admin.pool.query(`create database ${name}`);
  await admin.pool.end();
  const { db, pool } = makeDb(`postgres://postgres:t@localhost:${PG_PORT}/${name}`);
  await migrate(pool, opts);
  return { db, pool, name };
}

/** The tiny workspace image used by container tests; built once, reused. */
export async function ensureWorkspaceImage(): Promise<string> {
  try { sh('docker', ['image', 'inspect', FS_IMAGE], { ignore: true }); return FS_IMAGE; }
  catch { /* build below */ }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-img-'));
  await fs.writeFile(path.join(dir, 'Dockerfile'),
    'FROM alpine:3.20\nRUN apk add --no-cache ripgrep git\nWORKDIR /workspace/repo\n');
  sh('docker', ['build', '-q', '-t', FS_IMAGE, dir], { ignore: true });
  return FS_IMAGE;
}

/** THE temp root for anything a container bind-mounts. `/tmp` on both systems,
 *  no platform branch: on macOS it is the symlink to /private/tmp, which is one
 *  of Docker Desktop's default shared directories (docs.docker.com, Settings →
 *  Resources → File sharing: /Users /Volumes /private /tmp /var/folders), and on
 *  Linux it is the tmp dir itself. os.tmpdir() would be /var/folders on macOS —
 *  shared today, but it is where the empty-mount bug used to live, and this is
 *  the one path in the tests worth pinning by hand. Anything that is NOT a bind
 *  mount uses os.tmpdir() and names no path at all. */
export async function testRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join('/tmp', prefix));
}

/** Local git origin + working clone, seeded with one commit on main. */
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false',
    '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });
}

/** Workspace-level setting overrides are rows at the workspace's scope now, not
 *  columns. One helper so every fixture sets them the way the API does. */
export async function setWorkspaceSetting(db: any, workspaceId: string, key: string, value: unknown) {
  const { putScoped, workspaceScope } = await import('../phantom-backend/store.js');
  await putScoped(db, Buffer.alloc(32), workspaceScope(workspaceId), key, value, false);
}
