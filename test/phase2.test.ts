// Phase 2 integration: real Postgres, real docker container, tools through the
// real routes. Every root a container mounts comes from harness.testRoot() —
// /tmp, which Docker Desktop shares by default on macOS; nothing here names a
// path of its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testDb, ensureWorkspaceImage, testRoot, setWorkspaceSetting } from './harness.js';
import { makeDb } from '../phantom-backend/db/client.js';
import { migrate } from '../phantom-backend/db/migrate.js';
import { workspaces } from '../phantom-backend/db/schema.js';
import { makePaths, repoDir, type Paths } from '../phantom-backend/pool/paths.js';
import { bootCleanup } from '../phantom-backend/pool/pool.js';
import { buildApp } from '../phantom-backend/api/app.js';
import { makeDocker } from '../phantom-backend/docker.js';
import { ContainerManager } from '../phantom-backend/workspace/container.js';
import { newId } from '../core/ids.js';

const FS_IMAGE = 'phantom-test-fs';
let db: ReturnType<typeof makeDb>['db'];
let pgPool: ReturnType<typeof makeDb>['pool'];
let app: Awaited<ReturnType<typeof buildApp>>;
let paths: Paths;
let root: string;
let containers: ContainerManager;
let sessionId: string;

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false',
    '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });
}

before(async () => {
  // Tiny workspace image: busybox userland + the two hard requirements.
  await ensureWorkspaceImage();

  ({ db, pool: pgPool } = await testDb('p2'));

  root = await testRoot('phantom-p2-');
  paths = makePaths(path.join(root, 'workspaces'));
  await bootCleanup(paths);

  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['clone', '-q', bare, seed]);
  sh(seed, ['checkout', '-qb', 'main']);
  await fs.writeFile(path.join(seed, 'hello.ts'),
    'export function greet(name: string) {\n  return `hi ${name}`;\n}\n');
  await fs.mkdir(path.join(seed, 'docs'), { recursive: true });
  await fs.writeFile(path.join(seed, 'docs', 'notes.md'), '# Notes\n\nSee [[hello]].\n');
  sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'first']); sh(seed, ['push', '-q', 'origin', 'main']);

  const docker = makeDocker();
  containers = new ContainerManager(docker, paths);
  await containers.bootCleanup();

  app = await buildApp({
    db, paths, apiKey: 'k', encryptionKey: Buffer.alloc(32, 1), version: 'test',
    fs: { docker, containers },
    pgPool,
  });

  const workspaceId = newId();
  await db.insert(workspaces).values({
    id: workspaceId, url: `file://${bare}`, owner: 'local', name: 'fx',
    baseBranch: 'main', branchPrefix: 'agent', schemaName: `repo_${workspaceId}`,
  });
  await setWorkspaceSetting(db, workspaceId, 'container_image', FS_IMAGE);
  const r = await app.inject({ method: 'POST', url: '/sessions', headers: H, payload: { workspace_id: workspaceId } });
  sessionId = JSON.parse(r.body).data.id;
});

after(async () => {
  await containers?.bootCleanup(); // removes the session's container
  await app?.close();
  await pgPool?.end();
  await fs.rm(root, { recursive: true, force: true });
});

const H = { authorization: 'Bearer k' };
const HS = () => ({ ...H, 'x-phantom-looper-session': sessionId, 'content-type': 'application/json' });
const call = (tool: string, args: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/tools/${tool}`, headers: HS(), payload: args });
const json = (r: { body: string }) => JSON.parse(r.body);

test('GET /tools serves the neutral schema; session id is not a parameter', async () => {
  const r = await app.inject({ method: 'GET', url: '/tools', headers: H });
  const d = json(r).data;
  assert.equal(d.sessionHeader, 'x-phantom-looper-session');
  assert.deepEqual(d.tools.map((t: { name: string }) => t.name).sort(),
    ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write']);
  const edit = d.tools.find((t: { name: string }) => t.name === 'edit');
  assert.equal(edit.mutates, true);
  // The invariant: session never appears as a PARAMETER the model could set.
  for (const t of d.tools) {
    const props = Object.keys(t.input.properties ?? {});
    assert.ok(!props.some((p) => /session/i.test(p)), `${t.name} exposes a session parameter`);
  }
});

test('ls, read: numbered read through a real container', async () => {
  let r = await call('ls', {});
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(json(r).data.entries.includes('hello.ts'));
  r = await call('read', { path: 'hello.ts' });
  const content = json(r).data.content;
  assert.match(content, /^ {5}1\texport function greet/);
  r = await call('read', { path: 'nope.ts' });
  assert.equal(r.statusCode, 404);
  assert.equal(json(r).error.code, 'not_found');
});

test('edit: exact, fuzzy-with-disclosure, cat-n paste, not_unique', async () => {
  let r = await call('edit', { path: 'hello.ts', old_string: 'hi ${name}', new_string: 'hello ${name}' });
  assert.equal(r.statusCode, 200, r.body);
  let d = json(r).data;
  assert.equal(d.strategy, 'exact');
  assert.match(d.diff, /-.*hi \$\{name\}/);

  // whitespace drift -> fuzzy strategy applies AND says so
  r = await call('edit', { path: 'hello.ts', old_string: 'return   `hello ${name}`;', new_string: 'return `hello there ${name}`;' });
  d = json(r).data;
  assert.notEqual(d.strategy, 'exact');
  assert.ok(d.strategy, 'strategy must be disclosed');

  // the documented failure: numbered-read prefix pasted into old_string
  r = await call('edit', { path: 'hello.ts', old_string: '     1\texport function greet', new_string: 'x' });
  assert.equal(r.statusCode, 422);
  assert.equal(json(r).error.code, 'no_match');
  assert.match(json(r).error.message, /Did you mean/);

  await call('write', { path: 'dup.txt', content: 'same\nsame\n' });
  r = await call('edit', { path: 'dup.txt', old_string: 'same', new_string: 'x' });
  assert.equal(json(r).error.code, 'not_unique');
});

test('write + grep structured; find respects gitignore', async () => {
  await call('write', { path: 'src/deep/new.ts', content: 'const phantomMarker = 1;\n' });
  let r = await call('grep', { pattern: 'phantomMarker' });
  const m = json(r).data.matches;
  assert.equal(m.length, 1);
  assert.match(m[0].file, /new\.ts$/);
  assert.equal(m[0].line, 1);

  await call('write', { path: '.gitignore', content: 'ignored-dir/\n' });
  await call('write', { path: 'ignored-dir/x.ts', content: 'const hidden = 1;\n' });
  r = await call('find', { pattern: '**/*.ts' });
  const files = json(r).data.files.join('\n');
  assert.ok(!files.includes('ignored-dir'), 'find must respect .gitignore by default');
  r = await call('find', { pattern: '**/*.ts', include_ignored: true });
  assert.ok(json(r).data.files.join('\n').includes('ignored-dir'));
});

test('binary: write/read round-trip byte-identical; read refuses with binary_file', async () => {
  // Write binary via the workspace directly (the route body is JSON/text).
  const { Sandbox } = await import('../phantom-backend/workspace/sandbox.js');
  const docker = makeDocker();
  const c = docker.getContainer(`phantom-looper-ws-${sessionId}`);
  const ws = new Sandbox(docker, c);
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
  await ws.writeFile('blob.bin', bytes);
  const back = await ws.readFile('blob.bin');
  assert.equal(Buffer.compare(back.content, bytes), 0, 'binary round-trip must be byte-identical');
  const r = await call('read', { path: 'blob.bin' });
  assert.equal(r.statusCode, 422);
  assert.equal(json(r).error.code, 'binary_file');
});

test('ownership + mtime: container-written files are current and owned sanely', async () => {
  await call('write', { path: 'owned.txt', content: 'x' });
  const st = await fs.stat(path.join(repoDir(paths, sessionId), 'owned.txt'));
  assert.ok(Math.abs(Date.now() - st.mtimeMs) < 60_000, '1970 mtimes break make (T17c)');
});

test('container killed mid-session: next call recreates transparently, work intact', async () => {
  execFileSync('docker', ['rm', '-f', `phantom-looper-ws-${sessionId}`], { stdio: 'ignore' });
  const r = await call('read', { path: 'owned.txt' });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(json(r).data.content, /x/);
});

test('argv property: a filename with backticks is a filename', async () => {
  await call('write', { path: 'foo`whoami`.txt', content: 'safe' });
  const r = await call('read', { path: 'foo`whoami`.txt' });
  assert.match(json(r).data.content, /safe/);
  const ls = await call('ls', {});
  assert.ok(json(ls).data.entries.some((e: string) => e.includes('`whoami`')));
});

test('read returns images as images; multi-edit is all-or-nothing; grep literal+context', async () => {
  // 1x1 red PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const { Sandbox } = await import('../phantom-backend/workspace/sandbox.js');
  const docker = makeDocker();
  const ws = new Sandbox(docker, docker.getContainer(`phantom-looper-ws-${sessionId}`));
  await ws.writeFile('pixel.png', png);
  let r = await call('read', { path: 'pixel.png' });
  assert.equal(r.statusCode, 200, r.body);
  const img = json(r).data.image;
  assert.equal(img.media_type, 'image/png');
  assert.equal(Buffer.compare(Buffer.from(img.base64, 'base64'), png), 0, 'image bytes round-trip');

  await call('write', { path: 'multi.txt', content: 'alpha\nbeta\ngamma\n' });
  r = await call('edit', { path: 'multi.txt', edits: [
    { old_string: 'alpha', new_string: 'ALPHA' },
    { old_string: 'gamma', new_string: 'GAMMA' },
  ] });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(json(r).data.edits.length, 2);
  // atomicity: second edit fails -> first must NOT be applied
  r = await call('edit', { path: 'multi.txt', edits: [
    { old_string: 'beta', new_string: 'BETA' },
    { old_string: 'not-in-file', new_string: 'x' },
  ] });
  assert.equal(r.statusCode, 422);
  const after = await call('read', { path: 'multi.txt' });
  assert.match(json(after).data.content, /beta/, 'failed batch must leave the file untouched');

  await call('write', { path: 'ctx.txt', content: 'one\ntwo.three\nfour\n' });
  r = await call('grep', { pattern: 'two.three', literal: true, context: 1, path: 'ctx.txt' });
  const rows = json(r).data.matches;
  assert.ok(rows.some((m: { content: string; context?: boolean }) => m.content === 'two.three' && !m.context));
  assert.ok(rows.some((m: { content: string; context?: boolean }) => m.context && (m.content === 'one' || m.content === 'four')));
});

test('bash covers what dedicated tools no longer do (mkdir/mv/stat)', async () => {
  const r = await call('bash', { cmd: 'mkdir -p deep/dir && echo x > deep/dir/f.txt && mv deep/dir/f.txt deep/dir/g.txt && stat -c %s deep/dir/g.txt' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(json(r).data.exitCode, 0);
  assert.equal(json(r).data.stdout.trim(), '2');
});

test('unknown session and missing header fail with envelope codes', async () => {
  let r = await app.inject({ method: 'POST', url: '/tools/ls', headers: H, payload: {} });
  assert.equal(json(r).error.code, 'session_not_found');
  r = await app.inject({ method: 'POST', url: '/tools/ls',
    headers: { ...H, 'x-phantom-looper-session': 'nope', 'content-type': 'application/json' }, payload: {} });
  assert.equal(r.statusCode, 404);
});

// ── Skills routes ────────────────────────────────────────────────────────────
// Reads are host-side over the checkout; writes go through the container under
// the session lock. One flow: create → list → load → patch → bundled file →
// delete, plus the validation gate.
test('skills: create/list/load/patch/write_file/delete through the routes; bad writes refused', async () => {
  const SKILL = '---\nname: pdf-tools\ndescription: Extract text from PDFs. Use when working with PDF files.\n---\n\nRun the steps.\n';
  let r = await app.inject({ method: 'POST', url: '/skills', headers: HS(),
    payload: { action: 'create', name: 'pdf-tools', content: SKILL } });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(json(r).data.message, /created/);

  // The write happened IN the repo working tree, via the container.
  const onDisk = await fs.readFile(
    path.join(repoDir(paths, sessionId), '.agents/skills/pdf-tools/SKILL.md'), 'utf8');
  assert.equal(onDisk, SKILL);

  r = await app.inject({ method: 'GET', url: '/skills', headers: HS() });
  assert.deepEqual(json(r).data.skills,
    [{ name: 'pdf-tools', description: 'Extract text from PDFs. Use when working with PDF files.' }]);

  r = await app.inject({ method: 'POST', url: '/skills', headers: HS(),
    payload: { action: 'write_file', name: 'pdf-tools', file_path: 'references/api.md', file_content: 'API notes' } });
  assert.equal(r.statusCode, 200, r.body);

  r = await app.inject({ method: 'GET', url: '/skills/pdf-tools', headers: HS() });
  assert.equal(json(r).data.instructions, SKILL, 'load returns the whole body in one call');
  assert.deepEqual(json(r).data.files, ['references/api.md'], '...plus the bundled file names');
  r = await app.inject({ method: 'GET', url: '/skills/pdf-tools?file=references/api.md', headers: HS() });
  assert.equal(json(r).data.content, 'API notes');

  r = await app.inject({ method: 'POST', url: '/skills', headers: HS(),
    payload: { action: 'patch', name: 'pdf-tools', old_string: 'Run the steps.', new_string: 'Run ALL the steps.' } });
  assert.match(json(r).data.message, /1 replacement/);

  // The validation gate: a patch that would break the frontmatter is refused,
  // a create with a name/folder mismatch is refused, unknown skill 404s.
  r = await app.inject({ method: 'POST', url: '/skills', headers: HS(),
    payload: { action: 'patch', name: 'pdf-tools', old_string: 'description:', new_string: 'desc:' } });
  assert.equal(r.statusCode, 400);
  assert.match(json(r).error.message, /would break SKILL\.md/);
  r = await app.inject({ method: 'POST', url: '/skills', headers: HS(),
    payload: { action: 'create', name: 'other-name', content: SKILL } });
  assert.match(json(r).error.message, /must match/);
  r = await app.inject({ method: 'GET', url: '/skills/nope', headers: HS() });
  assert.equal(r.statusCode, 404);

  r = await app.inject({ method: 'POST', url: '/skills', headers: HS(),
    payload: { action: 'delete', name: 'pdf-tools' } });
  assert.equal(r.statusCode, 200, r.body);
  r = await app.inject({ method: 'GET', url: '/skills', headers: HS() });
  assert.deepEqual(json(r).data.skills, [], 'gone');
});

// ── Pull on missing ──────────────────────────────────────────────────────────
// The default workspace image is the published one at this server's version,
// so a fresh box has nothing local until the first session asks. Remove a
// small public image, point a workspace at it, and the first tool call must
// pull it rather than fail with "no such image".
test('a workspace image not on this machine is pulled on first use', async () => {
  const image = 'busybox:1.36';
  const docker = makeDocker();
  await docker.getImage(image).remove({ force: true }).catch(() => {});
  const workspaceId = newId();
  await db.insert(workspaces).values({
    id: workspaceId, url: `file://${path.join(root, 'origin.git')}`, owner: 'local', name: 'pull',
    baseBranch: 'main', branchPrefix: 'agent', schemaName: `repo_${workspaceId}`,
  });
  await setWorkspaceSetting(db, workspaceId, 'container_image', image);
  let r = await app.inject({ method: 'POST', url: '/sessions', headers: H, payload: { workspace_id: workspaceId } });
  const sid = JSON.parse(r.body).data.id;
  r = await app.inject({ method: 'POST', url: '/tools/ls', headers: { ...H, 'x-phantom-looper-session': sid, 'content-type': 'application/json' }, payload: {} });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(json(r).data.entries.includes('hello.ts'));
  await docker.getImage(image).inspect(); // it is here now
});

// Esc in the cli aborts the tool fetch; the server must KILL the running
// command, not just stop listening — Docker's API cannot kill an exec
// (moby#9098), so bash runs setsid'd with a pidfile and a second exec
// pkill -s's the whole session tree (children included) on disconnect.
test('client abort kills the running command and its children in the container', async () => {
  const addr = await app.listen({ port: 0, host: '127.0.0.1' });
  const ac = new AbortController();
  const outcome = fetch(`${addr}/tools/bash`, {
    method: 'POST', headers: HS(),
    body: JSON.stringify({ cmd: 'sleep 300 & sleep 300 & wait' }),
    signal: ac.signal,
  }).then(() => 'resolved', () => 'aborted');
  await new Promise((r) => setTimeout(r, 800)); // exec spawned, pidfile written
  ac.abort();
  assert.equal(await outcome, 'aborted');
  // TERM lands after the pidfile read; poll a few beats for the tree to go.
  let left = -1;
  for (let i = 0; i < 20 && left !== 0; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const r = await call('bash', { cmd: 'ps -e -o pid,args | grep "[s]leep 300" | wc -l' });
    const out = json(r).data?.stdout;
    if (out !== undefined) left = Number(out.trim());
  }
  assert.equal(left, 0, 'the killed command left no processes behind');
});

// The timeout path shares the kill: stream teardown alone used to orphan the
// process in the container ("the process still runs to completion" was real).
test('exec timeout kills the process, not just the stream', async () => {
  const r = await call('bash', { cmd: 'sleep 301 & sleep 301 & wait', timeout: 700 });
  assert.equal(json(r).error.code, 'exec_timeout');
  let left = -1;
  for (let i = 0; i < 20 && left !== 0; i++) {
    await new Promise((res) => setTimeout(res, 500));
    const p = await call('bash', { cmd: 'ps -e -o pid,args | grep "[s]leep 301" | wc -l' });
    const out = json(p).data?.stdout;
    if (out !== undefined) left = Number(out.trim());
  }
  assert.equal(left, 0, 'a timed-out command is dead, not orphaned');
});
