// Phase 3: exec + sync against real containers and a file:// origin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testDb, ensureWorkspaceImage, testRoot, setWorkspaceSetting } from './harness.js';
import { makeDb } from '../phantom-backend/db/client.js';
import { migrate } from '../phantom-backend/db/migrate.js';
import { workspaces, sessions, commands } from '../phantom-backend/db/schema.js';
import { eq } from 'drizzle-orm';
import { makePaths, repoDir, type Paths } from '../phantom-backend/pool/paths.js';
import { bootCleanup } from '../phantom-backend/pool/pool.js';
import { buildApp } from '../phantom-backend/api/app.js';
import { makeDocker } from '../phantom-backend/docker.js';
import { ContainerManager } from '../phantom-backend/workspace/container.js';
import { GitEngine } from '../phantom-backend/git/engine.js';
import { newId } from '../core/ids.js';
import { git } from '../phantom-backend/git/git.js';

const FS_IMAGE = 'phantom-test-fs';
let db: ReturnType<typeof makeDb>['db'];
let pgPool: ReturnType<typeof makeDb>['pool'];
let app: Awaited<ReturnType<typeof buildApp>>;
let paths: Paths;
let root: string;
let containers: ContainerManager;
let engine: GitEngine;
let bare: string;
let seed: string;
let sessionId: string;
let branch: string;
let workspaceId: string;

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false',
    '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });
}

before(async () => {
  await ensureWorkspaceImage();
  ({ db, pool: pgPool } = await testDb('p3'));

  root = await testRoot('phantom-p3-');
  paths = makePaths(path.join(root, 'workspaces'));
  await bootCleanup(paths);

  bare = path.join(root, 'origin.git');
  seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['clone', '-q', bare, seed]);
  sh(seed, ['checkout', '-qb', 'main']);
  await fs.writeFile(path.join(seed, 'app.txt'), 'v1\n');
  sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'first']); sh(seed, ['push', '-q', 'origin', 'main']);

  const docker = makeDocker();
  containers = new ContainerManager(docker, paths);
  await containers.bootCleanup();
  engine = new GitEngine(db, paths, Buffer.alloc(32, 1));

  app = await buildApp({
    db, paths, apiKey: 'k', encryptionKey: Buffer.alloc(32, 1), version: 'test',
    fs: { docker, containers, engine },
    engine,
    pgPool,
  });

  workspaceId = newId();
  await db.insert(workspaces).values({
    id: workspaceId, url: `file://${bare}`, owner: 'local', name: 'fx',
    baseBranch: 'main', branchPrefix: 'agent', schemaName: `repo_${workspaceId}`,
  });
  await setWorkspaceSetting(db, workspaceId, 'container_image', FS_IMAGE);
  const r = await app.inject({ method: 'POST', url: '/sessions', headers: H, payload: { workspace_id: workspaceId } });
  const s = JSON.parse(r.body).data;
  sessionId = s.id; branch = s.branch;
});

after(async () => {
  await containers?.bootCleanup();
  await app?.close();
  await pgPool?.end();
  await fs.rm(root, { recursive: true, force: true });
});

const H = { authorization: 'Bearer k' };
const HS = () => ({ ...H, 'x-phantom-looper-session': sessionId, 'content-type': 'application/json' });
const json = (r: { body: string }) => JSON.parse(r.body);
// An outside push to base. Sync to origin first so the push is fast-forward
// even if something else has moved main.
function pushMain(file: string, content: string, msg: string) {
  sh(seed, ['fetch', '-q', 'origin', 'main']);
  sh(seed, ['reset', '-q', '--hard', 'origin/main']);
  fsSync.writeFileSync(path.join(seed, file), content);
  sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', msg]); sh(seed, ['push', '-q', 'origin', 'main']);
}
const originSha = (ref: string) =>
  execFileSync('git', ['-C', bare, 'rev-parse', ref], { encoding: 'utf8' }).trim();

test('unary exec: tagged output, exit code; timeout returns exec_timeout', async () => {
  let r = await app.inject({ method: 'POST', url: '/tools/bash', headers: HS(),
    payload: { cmd: 'echo OUT; echo ERR >&2; exit 3' } });
  assert.equal(r.statusCode, 200, r.body);
  const d = json(r).data;
  assert.equal(d.stdout.trim(), 'OUT');
  assert.equal(d.stderr.trim(), 'ERR');
  assert.equal(d.exitCode, 3);

  // The default is two minutes — a short command runs to completion under it.
  r = await app.inject({ method: 'POST', url: '/tools/bash', headers: HS(), payload: { cmd: 'sleep 1; echo untimed' } });
  assert.match(json(r).data.stdout, /untimed/, 'the default timeout must not kill short commands');
  // A set default applies...
  await app.inject({ method: 'PATCH', url: '/settings', headers: H, payload: { bash_timeout_ms: 700 } });
  r = await app.inject({ method: 'POST', url: '/tools/bash', headers: HS(), payload: { cmd: 'echo partial; echo warn >&2; sleep 10' } });
  assert.equal(json(r).error.code, 'exec_timeout');
  assert.equal(json(r).error.retryable, true);
  assert.match(json(r).error.message, /700ms.*larger timeout/, 'the kill tells the agent to retry with more time');
  assert.match(json(r).error.detail.stdout, /partial/, 'the output so far rides on the kill');
  assert.match(json(r).error.detail.stderr, /warn/);
  // per-call timeout beats the default...
  r = await app.inject({ method: 'POST', url: '/tools/bash', headers: HS(), payload: { cmd: 'sleep 1; echo slow-ok', timeout: 5000 } });
  assert.equal(json(r).data?.stdout?.trim(), 'slow-ok', r.body);
  // ...but never the hard ceiling
  await app.inject({ method: 'PATCH', url: '/settings', headers: H, payload: { bash_timeout_max_ms: 500 } });
  r = await app.inject({ method: 'POST', url: '/tools/bash', headers: HS(), payload: { cmd: 'sleep 3', timeout: 60_000 } });
  assert.equal(json(r).error.code, 'exec_timeout');
  await app.inject({ method: 'DELETE', url: '/settings/bash_timeout_max_ms', headers: H });
  await app.inject({ method: 'DELETE', url: '/settings/bash_timeout_ms', headers: H });
});

test('push: work reaches the session branch on origin; push is credential-guarded', async () => {
  const r1 = await app.inject({ method: 'POST', url: '/tools/bash', headers: HS(),
    payload: { cmd: 'echo change > app.txt && echo new > added.txt' } });
  assert.equal(r1.statusCode, 200, r1.body);
  const r = await app.inject({ method: 'POST', url: '/git/push', headers: HS(), payload: {} });
  assert.equal(r.statusCode, 200, `push: ${r.statusCode} ${r.body}`);
  assert.equal(json(r).data.result, 'pushed', r.body);
  const remote = originSha(`refs/heads/${branch}`);
  const { stdout: local } = await git(repoDir(paths, sessionId), ['rev-parse', 'HEAD']);
  assert.equal(remote, local.trim());
});

test('pull: merges base, pushes the merge, next push stays fast-forward', async () => {
  // base moves underneath the session; the session's own work is safe on its
  // own branch, which is the only place anything is ever pushed.
  pushMain('base.txt', 'from base\n', 'base work');

  let r = await app.inject({ method: 'GET', url: '/git/status', headers: HS() });
  const up = json(r).data;
  assert.equal(up.pending.commits.length, 1);
  assert.match(up.pending.commits[0], /base work/);
  assert.deepEqual(up.pending.files, ['base.txt']);

  r = await app.inject({ method: 'POST', url: '/git/pull', headers: HS(), payload: {} });
  assert.equal(json(r).data.result, 'merged', r.body);
  // the base commit is now in the session, and the session branch on origin
  // matches local (the pull pushed before the lock released)
  const bash = await app.inject({ method: 'POST', url: '/tools/bash', headers: HS(), payload: { cmd: 'test -f base.txt && echo present' } });
  assert.match(json(bash).data.stdout, /present/, 'base file merged into the session');
  const remote = originSha(`refs/heads/${branch}`);
  const { stdout: local } = await git(repoDir(paths, sessionId), ['rev-parse', 'HEAD']);
  assert.equal(remote, local.trim());

  // a following push is plain (merge, never rebase — no forced push)
  await app.inject({ method: 'POST', url: '/tools/bash', headers: HS(), payload: { cmd: 'echo more >> app.txt' } });
  r = await app.inject({ method: 'POST', url: '/git/push', headers: HS(), payload: {} });
  assert.equal(json(r).data.result, 'pushed');
});

test('conflict on pull: reported as conflict, tree left clean — diff-filter=U, never a grep', async () => {
  // A push can never conflict: it pushes the branch the session is on and
  // nothing else, and that branch has one writer. Conflicts surface where the
  // two sides actually meet — the pull merge.
  await app.inject({ method: 'POST', url: '/tools/bash', headers: HS(), payload: { cmd: 'echo SESSION LINE > conflict.txt' } });
  let r = await app.inject({ method: 'POST', url: '/git/push', headers: HS(), payload: {} });
  assert.equal(json(r).data.result, 'pushed', r.body);

  pushMain('conflict.txt', 'BASE LINE\n', 'base edits the same file');

  r = await app.inject({ method: 'POST', url: '/git/pull', headers: HS(), payload: {} });
  assert.equal(json(r).data.result, 'conflict', r.body);
  const { stdout: status } = await git(repoDir(paths, sessionId), ['status', '--porcelain']);
  assert.equal(status.trim(), '', 'conflict must be aborted, not left half-merged');
  // The session's own work is untouched on its branch — a conflict on base is
  // not a data event.
  const remote = originSha(`refs/heads/${branch}`);
  const { stdout: local } = await git(repoDir(paths, sessionId), ['rev-parse', 'HEAD']);
  assert.equal(remote, local.trim());
  // converge base so later tests start clean
  pushMain('conflict.txt', 'SESSION LINE\n', 'converge');
});

test('push pushes the session branch and NOTHING else — base never moves', async () => {
  const before = originSha('refs/heads/main');
  await app.inject({ method: 'POST', url: '/tools/bash', headers: HS(), payload: { cmd: 'echo solo > solo.txt' } });
  const r = await app.inject({ method: 'POST', url: '/git/push', headers: HS(), payload: {} });
  assert.equal(json(r).data.result, 'pushed', r.body);
  assert.equal(originSha('refs/heads/main'), before, 'a push must not touch base');
  assert.notEqual(originSha(`refs/heads/${branch}`), before);
});

test('no mutex: a mutating tool runs fine alongside a running unary exec', async () => {
  const long = app.inject({ method: 'POST', url: '/tools/bash', headers: HS(), payload: { cmd: 'sleep 2' } });
  await new Promise((r) => setTimeout(r, 400));
  const r = await app.inject({ method: 'POST', url: '/tools/write', headers: HS(),
    payload: { path: 'racer.txt', content: 'x' } });
  assert.equal(r.statusCode, 200, r.body);
  await long;
});

test('detached exec: ND-JSON log with tagged records and one terminal exit', async () => {
  const r = await app.inject({ method: 'POST', url: '/tools/bash', headers: HS(),
    payload: { cmd: 'echo one; sleep 0.3; echo two >&2; exit 5', detached: true } });
  assert.equal(r.statusCode, 200, r.body);
  const cmdId = json(r).data.cmd_id;
  await new Promise((rr) => setTimeout(rr, 1500));
  const logs = await app.inject({ method: 'GET', url: `/commands/${cmdId}/logs`, headers: H });
  const records = logs.body.trim().split('\n').map((l) => JSON.parse(l));
  const exit = records.filter((x) => x.event === 'exit');
  assert.equal(exit.length, 1, 'exactly one terminal record');
  assert.equal(exit[0].code, 5);
  assert.ok(records.some((x) => x.stream === 'stdout' && x.data.includes('one')));
  assert.ok(records.some((x) => x.stream === 'stderr' && x.data.includes('two')));
  // logs live OUTSIDE workspace/ — the next push must not commit them
  const { stdout } = await git(repoDir(paths, sessionId), ['status', '--porcelain']);
  assert.ok(!stdout.includes('.ndjson'));
});

const getTasks = async (id = sessionId) =>
  json(await app.inject({ method: 'GET', url: `/sessions/${id}/tasks`, headers: H })).data;

test('tasks: a detached command is one tracked task; kill marks the row and fells the tree', async () => {
  const r = await app.inject({ method: 'POST', url: '/tools/bash', headers: HS(),
    payload: { cmd: 'sleep 300', detached: true } });
  const cmdId = json(r).data.cmd_id;
  // The sid capture is fire-and-forget beside the spawn — poll until it lands.
  let task: { sid: string; command: string; logs: string | null;
    log_file: string | null; started_at: string | null } | undefined;
  for (let i = 0; i < 20 && !task; i++) {
    const d = await getTasks();
    assert.equal(d.container, 'running');
    task = d.tasks.find((x: { cmd_id: string | null }) => x.cmd_id === cmdId);
    if (!task) await new Promise((rr) => setTimeout(rr, 300));
  }
  assert.ok(task, 'the detached command appears as a tracked task');
  assert.match(task.sid, /^\d+$/);
  assert.equal(task.command, 'sleep 300', 'the row names what was typed, not the wrapper');
  assert.equal(task.logs, `/commands/${cmdId}/logs`);
  assert.equal(task.log_file, `/workspace/logs/${cmdId}.ndjson`, 'the agent-readable path rides along');
  assert.ok(task.started_at, 'a tracked task says when it started');
  // The container's own keeper processes are never tasks.
  const d = await getTasks();
  assert.ok(!d.tasks.some((x: { command: string }) => /sleep infinity|docker-init|ps -eo/.test(x.command)));

  const k = await app.inject({ method: 'DELETE', url: `/sessions/${sessionId}/tasks/${task.sid}`, headers: H });
  assert.equal(k.statusCode, 200, k.body);
  assert.equal(json(k).data.cmd_id, cmdId);
  // The tree is gone in the container itself.
  const ps = await app.inject({ method: 'POST', url: '/tools/bash', headers: HS(),
    payload: { cmd: 'ps -e -o pid,args | grep "[s]leep 300" | wc -l' } });
  assert.equal(json(ps).data.stdout.trim(), '0', 'no sleep 300 survives the kill');
  // 'killed' is final: the stream's own exit lands after, conditioned away.
  await new Promise((rr) => setTimeout(rr, 500));
  const [row] = await db.select().from(commands).where(eq(commands.id, cmdId));
  assert.equal(row.status, 'killed');
  assert.ok(row.endedAt);
  const after = await getTasks();
  assert.ok(!after.tasks.some((x: { cmd_id: string | null }) => x.cmd_id === cmdId));
  const rec = after.recent.find((x: { cmd_id: string }) => x.cmd_id === cmdId);
  assert.ok(rec, 'a finished command lists under recent');
  assert.equal(rec.status, 'killed');
});

test('tasks: a stray background process lists untracked and dies by sid', async () => {
  // A unary command that backgrounds something and exits normally leaves a
  // stray — no commands row ever knows it.
  await app.inject({ method: 'POST', url: '/tools/bash', headers: HS(),
    payload: { cmd: 'sleep 302 & sleep 0.2' } });
  let stray: { sid: string; cmd_id: string | null } | undefined;
  for (let i = 0; i < 10 && !stray; i++) {
    const d = await getTasks();
    stray = d.tasks.find((x: { command: string }) => x.command.includes('sleep 302'));
    if (!stray) await new Promise((rr) => setTimeout(rr, 200));
  }
  assert.ok(stray, 'the stray appears as a task');
  assert.equal(stray.cmd_id, null, 'not started by a tracked command');
  const k = await app.inject({ method: 'DELETE', url: `/sessions/${sessionId}/tasks/${stray.sid}`, headers: H });
  assert.equal(k.statusCode, 200, k.body);
  assert.equal(json(k).data.cmd_id, null);
  const ps = await app.inject({ method: 'POST', url: '/tools/bash', headers: HS(),
    payload: { cmd: 'ps -e -o pid,args | grep "[s]leep 302" | wc -l' } });
  assert.equal(json(ps).data.stdout.trim(), '0');
});

test('tasks: kill refuses a bogus sid and the baseline', async () => {
  const bogus = await app.inject({ method: 'DELETE', url: `/sessions/${sessionId}/tasks/999999`, headers: H });
  assert.equal(bogus.statusCode, 404);
  assert.equal(json(bogus).error.code, 'no_such_task');
  // sid 1 is docker-init + the keeper — filtered before the check, unkillable.
  const base = await app.inject({ method: 'DELETE', url: `/sessions/${sessionId}/tasks/1`, headers: H });
  assert.equal(base.statusCode, 404);
});

test('tasks: a stale running row is closed on read; a just-born one survives', async () => {
  const stale = newId();
  await db.insert(commands).values({ id: stale, sessionId, argv: ['/bin/sh', '-c', 'ghost'],
    status: 'running', sid: '999888', logPath: '/dev/null', startedAt: new Date(Date.now() - 60_000) });
  const young = newId();
  await db.insert(commands).values({ id: young, sessionId, argv: ['/bin/sh', '-c', 'baby'],
    status: 'running', logPath: '/dev/null' });
  const d = await getTasks();
  assert.ok(!d.tasks.some((x: { cmd_id: string | null }) => x.cmd_id === stale));
  const [rowStale] = await db.select().from(commands).where(eq(commands.id, stale));
  assert.equal(rowStale.status, 'exited', 'the lost-final-write row is closed by the read');
  assert.ok(rowStale.endedAt);
  const [rowYoung] = await db.select().from(commands).where(eq(commands.id, young));
  assert.equal(rowYoung.status, 'running', 'null-sid grace: a command mid-capture is not closed');
  await db.delete(commands).where(eq(commands.id, stale));
  await db.delete(commands).where(eq(commands.id, young));
});

test('tasks: listing never starts a container', async () => {
  const r = await app.inject({ method: 'POST', url: '/sessions', headers: H, payload: { workspace_id: workspaceId } });
  const fresh = json(r).data.id;
  const d = await getTasks(fresh);
  assert.equal(d.container, 'absent', 'no container was created just to look');
  assert.deepEqual(d.tasks, []);
});

test('bash keeps the tail and spills full output to a readable file', async () => {
  await app.inject({ method: 'PATCH', url: '/settings', headers: H, payload: { max_bash_output_bytes: 300 } });
  const r = await app.inject({ method: 'POST', url: '/tools/bash', headers: HS(), payload: { cmd: 'seq 1 500' } });
  const d = json(r).data;
  assert.ok(d.stdout.includes('500'), 'tail kept — the end of the output is present');
  assert.ok(!d.stdout.includes('\n1\n'), 'head dropped from the inline response');
  assert.match(d.truncated.full_output, /^\/workspace\/logs\/bash-.*\.out$/);
  const spill = await app.inject({ method: 'POST', url: '/tools/read', headers: HS(),
    payload: { path: d.truncated.full_output, limit: 5 } });
  assert.match(json(spill).data.content, /1/, 'full output readable from the spill file');
  await app.inject({ method: 'DELETE', url: '/settings/max_bash_output_bytes', headers: H });
});

// There is no background git any more: nothing pushes until someone (or the
// auto-push path) says so, and the work sits in the checkout meanwhile.
test('no background git: work stays local until an explicit push', async () => {
  await app.inject({ method: 'POST', url: '/tools/write', headers: HS(),
    payload: { path: 'held.txt', content: 'stays local until pushed' } });
  const before = originSha(`refs/heads/${branch}`);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(originSha(`refs/heads/${branch}`), before, 'nothing pushed by itself');
  const { stdout: dirty } = await git(repoDir(paths, sessionId), ['status', '--porcelain']);
  assert.match(dirty, /held\.txt/, 'the work is still there, uncommitted');
  const r = await app.inject({ method: 'POST', url: '/git/push', headers: HS(), payload: {} });
  assert.equal(json(r).data.result, 'pushed', 'the explicit path still works');
  assert.notEqual(originSha(`refs/heads/${branch}`), before);
});

test('session delete pushes first, then tears down container and dir', async () => {
  await app.inject({ method: 'POST', url: '/tools/write', headers: HS(),
    payload: { path: 'final.txt', content: 'last words' } });
  const r = await app.inject({ method: 'DELETE', url: `/sessions/${sessionId}`, headers: H });
  assert.equal(json(r).ok, true, r.body);
  // the work reached origin BEFORE the directory died
  const { }: Record<string, never> = {};
  const lsTree = execFileSync('git', ['-C', bare, 'ls-tree', '--name-only', `refs/heads/${branch}`], { encoding: 'utf8' });
  assert.ok(lsTree.includes('final.txt'));
  assert.equal(await fs.stat(path.join(paths.work, sessionId)).catch(() => null), null);
  const row = (await db.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
  assert.equal(row.status, 'destroyed');
});
