// Full-stack phase 1 verify: real Postgres (throwaway container), real git
// (file:// origins), real HTTP routes via fastify.inject. Run with a docker
// daemon up; CI provides one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testDb, ensureWorkspaceImage, testRoot, setWorkspaceSetting } from './harness.js';
import { makeDb } from '../phantom-backend/db/client.js';
import { migrate } from '../phantom-backend/db/migrate.js';
import { workspaces, sessions } from '../phantom-backend/db/schema.js';
import { eq } from 'drizzle-orm';
import { makePaths, repoDir, type Paths } from '../phantom-backend/pool/paths.js';
import { bootCleanup, tick, claimSlot } from '../phantom-backend/pool/pool.js';
import { buildApp } from '../phantom-backend/api/app.js';
import { git, commitAll, pushSession } from '../phantom-backend/git/git.js';
import { newId } from '../core/ids.js';

let db: ReturnType<typeof makeDb>['db'];
let pgPool: ReturnType<typeof makeDb>['pool'];
let app: Awaited<ReturnType<typeof buildApp>>;
let paths: Paths;
let root: string;
let originUrl: string;

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false',
    '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });
}

before(async () => {
  ({ db, pool: pgPool } = await testDb('integration'));

  root = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-int-'));
  paths = makePaths(path.join(root, 'workspaces'));
  await bootCleanup(paths);

  // A local origin with two commits on main.
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['clone', '-q', bare, seed]);
  sh(seed, ['checkout', '-qb', 'main']);
  await fs.writeFile(path.join(seed, 'a.txt'), 'one\n');
  sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'first']);
  await fs.writeFile(path.join(seed, 'b.txt'), 'two\n');
  sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'second']);
  // A skill in the repo — the create-session response scans .agents/skills.
  await fs.mkdir(path.join(seed, '.agents/skills/deploy-checks'), { recursive: true });
  await fs.writeFile(path.join(seed, '.agents/skills/deploy-checks/SKILL.md'),
    '---\nname: deploy-checks\ndescription: Use when deploying. Run the checklist.\n---\n\nSteps.\n');
  sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'skill']);
  sh(seed, ['push', '-q', 'origin', 'main']);
  originUrl = `file://${bare}`;

  app = await buildApp({
    db, paths, apiKey: 'test-key', encryptionKey: Buffer.alloc(32, 9), version: 'test',
    pgPool,
  });
});

after(async () => {
  await app?.close();
  await pgPool?.end();
  await fs.rm(root, { recursive: true, force: true });
});

const H = { authorization: 'Bearer test-key' };
const json = (r: { body: string }) => JSON.parse(r.body);

test('auth: no token -> 401 envelope, health included; no anonymous surface', async () => {
  const noAuth = await app.inject({ method: 'GET', url: '/settings' });
  assert.equal(noAuth.statusCode, 401);
  assert.equal(json(noAuth).ok, false);

  // /health used to be open, which published the version to anyone. The
  // container's HEALTHCHECK sends the key, so nothing needs it anonymous.
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 401);
  const authed = await app.inject({ method: 'GET', url: '/health', headers: H });
  assert.equal(authed.statusCode, 200);
  assert.equal(json(authed).ok, true);

  // An unrouted path must 401 too, never 404 — a 404 would confirm which
  // routes exist to someone with no token.
  const unrouted = await app.inject({ method: 'GET', url: '/nope' });
  assert.equal(unrouted.statusCode, 401);
});

test('settings: override then delete reverts to the code default', async () => {
  let r = await app.inject({ method: 'GET', url: '/settings', headers: H });
  assert.equal(json(r).data.spare_clones.value, 2);
  assert.equal(json(r).data.spare_clones.source, 'default');

  r = await app.inject({ method: 'PATCH', url: '/settings', headers: H, payload: { spare_clones: 5 } });
  assert.equal(json(r).ok, true);
  r = await app.inject({ method: 'GET', url: '/settings', headers: H });
  assert.equal(json(r).data.spare_clones.value, 5);
  assert.equal(json(r).data.spare_clones.source, 'override');

  r = await app.inject({ method: 'DELETE', url: '/settings/spare_clones', headers: H });
  assert.equal(json(r).ok, true);
  r = await app.inject({ method: 'GET', url: '/settings', headers: H });
  assert.equal(json(r).data.spare_clones.value, 2);
  assert.equal(json(r).data.spare_clones.source, 'default');

  // Null clears — ONE rule at every layer, same as DELETE, same as the
  // workspace PATCH. Null is never a stored value.
  await app.inject({ method: 'PATCH', url: '/settings', headers: H, payload: { spare_clones: 9 } });
  r = await app.inject({ method: 'PATCH', url: '/settings', headers: H, payload: { spare_clones: null } });
  assert.equal(json(r).ok, true);
  r = await app.inject({ method: 'GET', url: '/settings', headers: H });
  assert.equal(json(r).data.spare_clones.value, 2, 'null reverted to the default');
  assert.equal(json(r).data.spare_clones.source, 'default');

  r = await app.inject({ method: 'PATCH', url: '/settings', headers: H, payload: { nonsense: 1 } });
  assert.equal(r.statusCode, 400);
});

let workspaceId: string;

test('workspaces: create, credential is write-only, the GET shows the settings chain', async () => {
  let r = await app.inject({ method: 'POST', url: '/workspaces', headers: H,
    payload: { url: 'https://github.com/acme/widgets.git' } });
  assert.equal(r.statusCode, 201);
  const workspace = json(r).data;
  workspaceId = workspace.id;
  assert.equal(workspace.owner, 'acme');
  assert.equal(workspace.displayName, 'widgets', 'defaults to the workspace name from the URL');
  assert.equal(workspace.hasCredential, false);
  const named = await app.inject({ method: 'PATCH', url: `/workspaces/${workspace.id}`, headers: H, payload: { display_name: 'Widgets (prod)' } });
  assert.equal(json(named).data.displayName, 'Widgets (prod)');
  const reverted = await app.inject({ method: 'PATCH', url: `/workspaces/${workspace.id}`, headers: H, payload: { display_name: '' } });
  assert.equal(json(reverted).data.displayName, 'widgets');
  assert.equal('credentialEnc' in workspace, false, 'no ciphertext column, and none in the payload');

  r = await app.inject({ method: 'POST', url: '/workspaces', headers: H,
    payload: { url: 'https://u:tok@github.com/x/y' } });
  assert.equal(r.statusCode, 400, 'embedded credentials rejected at the door');

  // A workspace's own token is `github_token` at its layer — the same key the
  // global one uses one layer down. There is no /credential route any more.
  r = await app.inject({ method: 'PATCH', url: `/settings?workspace=${workspaceId}`, headers: H,
    payload: { github_token: 'ghp_secret' } });
  assert.equal(json(r).ok, true, r.body);
  r = await app.inject({ method: 'GET', url: `/workspaces/${workspaceId}`, headers: H });
  assert.equal(json(r).data.hasCredential, true);
  assert.equal(JSON.stringify(json(r)).includes('ghp_secret'), false,
    'the workspace payload still carries no credential');
  // ...but the settings route DOES return it decrypted. That is the whole
  // reason settings and secrets could become one system.
  r = await app.inject({ method: 'GET', url: `/settings?workspace=${workspaceId}`, headers: H });
  assert.equal(json(r).data.github_token.value, 'ghp_secret');
  assert.equal(json(r).data.github_token.secret, true);

  // workspace-level override beats the settings row; the plain GET carries the
  // LAYERS, not just the winner — and the old /effective endpoint is gone.
  await app.inject({ method: 'PATCH', url: `/workspaces/${workspaceId}`, headers: H, payload: { spare_clones: 7 } });
  r = await app.inject({ method: 'GET', url: `/workspaces/${workspaceId}`, headers: H });
  const sc = json(r).data.settings.spare_clones;
  assert.equal(sc.value, 7);
  assert.equal(sc.source, 'workspace');
  assert.equal(sc.workspace, 7, 'the workspace layer is exposed');
  assert.notEqual(sc.default, 7, 'the default layer rides along');
  assert.equal(sc.global, null, 'no global override set');
  r = await app.inject({ method: 'GET', url: `/workspaces/${workspaceId}/effective`, headers: H });
  assert.equal(r.statusCode, 404, '/effective is folded into the plain GET');
});

test('sessions: 20 concurrent creates -> 20 distinct working branches', async () => {
  // Point a workspace at the local origin (route validation only accepts github
  // URLs, so the file:// fixture goes straight into the table).
  const localId = newId();
  await db.insert(workspaces).values({
    id: localId, url: originUrl, owner: 'local', name: 'fixture',
    baseBranch: 'main', branchPrefix: 'agent', schemaName: `wsp_${localId}`,
  });

  const rs = await Promise.all(Array.from({ length: 20 }, () =>
    app.inject({ method: 'POST', url: '/sessions', headers: H, payload: { workspace_id: localId } })));
  const bodies = rs.map((r) => { assert.equal(r.statusCode, 201, r.body); return json(r).data; });
  const ids = new Set(bodies.map((b) => b.id));
  assert.equal(ids.size, 20);
  for (const b of bodies) {
    const dir = repoDir(paths, b.id);
    // One branch, start to finish: the checkout IS the branch that gets pushed.
    const { stdout } = await git(dir, ['branch', '--show-current']);
    assert.equal(stdout.trim(), b.branch);
    assert.match(b.branch, /^agent\//);
    const { stdout: sha } = await git(dir, ['rev-parse', 'HEAD']);
    assert.equal(sha.trim(), b.claimSha);
  }
});

test('a session always works on its own branch, cut from base', async () => {
  // No setting for this: the work branch is {prefix}/{id}, always.
  const localId = newId();
  await db.insert(workspaces).values({
    id: localId, url: originUrl, owner: 'local', name: 'onbase',
    baseBranch: 'main', branchPrefix: 'agent', schemaName: `wsp_${localId}`,
  });
  const r = await app.inject({ method: 'POST', url: '/sessions', headers: H, payload: { workspace_id: localId } });
  assert.equal(r.statusCode, 201, r.body);
  const s = json(r).data;
  assert.equal(s.branch, `agent/${s.id}`, 'the branch recorded on the row is the session\'s own');
  const { stdout } = await git(repoDir(paths, s.id), ['branch', '--show-current']);
  assert.equal(stdout.trim(), `agent/${s.id}`);
  // The response carries the repo's skill index, scanned AFTER checkout — a
  // client freezes it into the agent's prompt before the first turn.
  assert.deepEqual(s.skills, [
    { name: 'deploy-checks', description: 'Use when deploying. Run the checklist.' },
  ], 'skills ride the create response');
});

test('restart: destroy deletes the FILES, and creating with the same id picks the branch back up', async () => {
  const localId = newId();
  await db.insert(workspaces).values({
    id: localId, url: originUrl, owner: 'local', name: 'restart',
    baseBranch: 'main', branchPrefix: 'agent', schemaName: `wsp_${localId}`,
  });
  let r = await app.inject({ method: 'POST', url: '/sessions', headers: H, payload: { workspace_id: localId } });
  const s = json(r).data;
  const dir = repoDir(paths, s.id);

  // Work, commit, push — exactly what a push does.
  await fs.writeFile(path.join(dir, 'restart.txt'), 'work that must survive\n');
  await commitAll(dir, 'work');
  assert.equal(await pushSession(dir, s.branch, { url: originUrl }), 'pushed');

  // A restart while it is still active is refused: it still owns its directory.
  r = await app.inject({ method: 'POST', url: '/sessions', headers: H,
    payload: { workspace_id: localId, id: s.id } });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(json(r).error.code, 'already_active');

  r = await app.inject({ method: 'DELETE', url: `/sessions/${s.id}`, headers: H });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await fs.access(dir).then(() => true, () => false), false, 'files are gone');
  // The ROW survives, and the FOLDER remembers the branch — that is the
  // whole of resume: conversations on sessions, checkout facts on folders.
  const [row] = await db.select().from(sessions).where(eq(sessions.id, s.id));
  assert.equal(row.status, 'destroyed');
  const { folders } = await import('../phantom-backend/db/schema.js');
  const [folderRow] = await db.select().from(folders).where(eq(folders.id, String(row.folderId)));
  assert.equal(folderRow.branch, s.branch);

  r = await app.inject({ method: 'POST', url: '/sessions', headers: H,
    payload: { workspace_id: localId, id: s.id } });
  assert.equal(r.statusCode, 201, r.body);
  const back = json(r).data;
  assert.equal(back.id, s.id);
  assert.equal(back.branch, s.branch);
  assert.equal(back.status, 'active');
  const { stdout } = await git(dir, ['branch', '--show-current']);
  assert.equal(stdout.trim(), s.branch, 'restarted on its own branch');
  assert.equal(await fs.readFile(path.join(dir, 'restart.txt'), 'utf8'), 'work that must survive\n',
    'the work that was pushed to the branch came back with it');
});

test('pool tick stocks the local workspace; a claimed slot is current', async () => {
  await tick(db, paths, Buffer.alloc(32, 9));
  const ready = await fs.readdir(paths.poolReady);
  const mine = ready.filter((s) => s.startsWith('local__fixture__main__'));
  assert.ok(mine.length >= 1, 'tick stocked nothing');
  // Move the origin forward, then claim: the claim-path fetch must land on the new head.
  const seed = path.join(root, 'seed');
  await fs.writeFile(path.join(seed, 'c.txt'), 'three\n');
  sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'third']); sh(seed, ['push', '-q', 'origin', 'main']);
  const r = await app.inject({ method: 'POST', url: '/sessions', headers: H,
    payload: { workspace_id: (await db.select().from(workspaces)).find((x) => x.owner === 'local')!.id } });
  const s = json(r).data;
  const { stdout } = await git(repoDir(paths, s.id), ['log', '-1', '--format=%s']);
  assert.equal(stdout.trim(), 'third', 'claimed slot was stale — the claim fetch is the correctness guarantee');
});

test('destroy: refuses to discard work without force, honors force', async () => {
  const localId = (await db.select().from(workspaces)).find((x) => x.owner === 'local')!.id;
  const created = json(await app.inject({ method: 'POST', url: '/sessions', headers: H, payload: { workspace_id: localId } })).data;
  // Session did work that never got pushed: sweep-style destroy must refuse.
  await fs.writeFile(path.join(repoDir(paths, created.id), 'work.txt'), 'unpushed');
  let r = await app.inject({ method: 'DELETE', url: `/sessions/${created.id}`, headers: H });
  assert.equal(r.statusCode, 409);
  assert.equal(json(r).error.code, 'unpushed_work');
  r = await app.inject({ method: 'DELETE', url: `/sessions/${created.id}?force=true`, headers: H });
  assert.equal(json(r).ok, true);
  assert.equal((await fs.stat(path.join(paths.work, created.id)).catch(() => null)), null);
});

test('credential chain IS the settings chain: workspace token beats global', async () => {
  // This used to be a hand-written chain in pool.ts reading a column and then a
  // secrets table. It is `github_token` resolved through the same layers as
  // every other setting, so there is nothing chain-shaped left to get wrong.
  const { resolveAuth } = await import('../phantom-backend/pool/pool.js');
  const { putScoped, dropKey, workspaceScope } = await import('../phantom-backend/store.js');
  const key = Buffer.alloc(32, 9);
  // Fresh rows: earlier tests gave some workspaces a token of their own, and
  // "bare" has to actually be bare.
  const bareId = newId(); const ownId = newId();
  await db.insert(workspaces).values([
    { id: bareId, url: 'https://github.com/x/bare.git', owner: 'x', name: 'bare',
      baseBranch: 'main', branchPrefix: 'agent', schemaName: `wsp_${bareId}` },
    { id: ownId, url: 'https://github.com/x/own.git', owner: 'x', name: 'own',
      baseBranch: 'main', branchPrefix: 'agent', schemaName: `wsp_${ownId}` },
  ]);
  const [bare] = await db.select().from(workspaces).where(eq(workspaces.id, bareId));
  const [own] = await db.select().from(workspaces).where(eq(workspaces.id, ownId));

  await putScoped(db, key, 'global', 'github_token', 'ghp_global', true);
  assert.equal((await resolveAuth(db, bare, key)).pat, 'ghp_global');

  await putScoped(db, key, workspaceScope(own.id), 'github_token', 'ghp_mine', true);
  assert.equal((await resolveAuth(db, own, key)).pat, 'ghp_mine', 'its own layer wins');
  assert.equal((await resolveAuth(db, bare, key)).pat, 'ghp_global', 'the other still gets the global one');

  await dropKey(db, 'github_token', 'global');
  assert.equal((await resolveAuth(db, bare, key)).pat, undefined, 'no token anywhere = unauthenticated');
  assert.equal((await resolveAuth(db, own, key)).pat, 'ghp_mine', 'its own is untouched');
  await dropKey(db, 'github_token', workspaceScope(own.id));
});

test('a credential is a key of the one store, stored encrypted, read back plain', async () => {
  let r = await app.inject({ method: 'PATCH', url: '/settings', headers: H,
    payload: { anthropic_api_key: 'sk-ant-test' } });
  assert.equal(json(r).ok, true, r.body);

  // On disk it is ciphertext in value_enc; value is null. The two CHECK
  // constraints make the other arrangement unrepresentable.
  const raw = await pgPool.query(
    "select value, value_enc, secret from phantom_looper.settings where key='anthropic_api_key'");
  assert.equal(raw.rows[0].value, null);
  assert.equal(raw.rows[0].secret, true);
  assert.ok(raw.rows[0].value_enc?.length > 0);
  assert.equal(raw.rows[0].value_enc.toString('utf8').includes('sk-ant-test'), false, 'encrypted at rest');

  r = await app.inject({ method: 'GET', url: '/settings', headers: H });
  assert.equal(json(r).data.anthropic_api_key.value, 'sk-ant-test');
  assert.equal(json(r).data.anthropic_api_key.secret, true);

  // A credential is not a per-workspace thing unless it says so.
  const wsId = (await db.select().from(workspaces))[0].id;
  r = await app.inject({ method: 'PATCH', url: `/settings?workspace=${wsId}`, headers: H,
    payload: { anthropic_api_key: 'sk-nope' } });
  assert.equal(r.statusCode, 400);
  assert.equal(json(r).error.code, 'not_overridable');

  // Secret-ness is declared in code, never by a write — the wrapped
  // {value, secret} form is gone with the namespaces, so it is just a bad value.
  r = await app.inject({ method: 'PATCH', url: '/settings', headers: H,
    payload: { spare_clones: { value: 'x', secret: true } } });
  assert.equal(r.statusCode, 400);

  await app.inject({ method: 'DELETE', url: '/settings/anthropic_api_key', headers: H });
});

test('workspace delete refuses while sessions are active', async () => {
  const localId = (await db.select().from(workspaces)).find((x) => x.owner === 'local')!.id;
  const r = await app.inject({ method: 'DELETE', url: `/workspaces/${localId}`, headers: H });
  assert.equal(r.statusCode, 409);
  assert.equal(json(r).error.code, 'sessions_exist');
});

test('BOTH write paths validate — a workspace override cannot store what /settings refuses', async () => {
  // The workspace PATCH used to skip validateSetting entirely, so a value the
  // global path refused was stored per workspace. With
  // session_idle_destroy_ms: -1 every session in the workspace read as idle and
  // the next sweep deleted every clone (sessions.ts: `now - lastUsed < idleMs`).
  for (const payload of [{ spare_clones: -5 }, { session_idle_destroy_ms: -1 },
    { idle_destroy_ms: -1 }, { initial_history_depth: '7.dayz' }]) {
    const r = await app.inject({ method: 'PATCH', url: `/workspaces/${workspaceId}`,
      headers: H, payload });
    assert.equal(r.statusCode, 400, `${JSON.stringify(payload)} must be refused`);
    assert.equal(json(r).error.code, 'invalid_setting');
  }
  // Null still clears — it is not a value, so it is never validated.
  const cleared = await app.inject({ method: 'PATCH', url: `/workspaces/${workspaceId}`,
    headers: H, payload: { spare_clones: null } });
  assert.equal(cleared.statusCode, 200);
});

test('PATCH /settings rejects wrong-typed values instead of storing them', async () => {
  const bad = await app.inject({ method: 'PATCH', url: '/settings', headers: H,
    payload: { spare_clones: 'banana' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(json(bad).error.code, 'invalid_setting');
  assert.match(json(bad).error.message, /spare_clones must be a number/);

  const choice = await app.inject({ method: 'PATCH', url: '/settings', headers: H,
    payload: { git_fixer_provider: 'gemini' } });
  assert.equal(choice.statusCode, 400);
  assert.match(json(choice).error.message, /must be one of/);

  const nulled = await app.inject({ method: 'PATCH', url: '/settings', headers: H,
    payload: { spare_clones: null } });
  assert.equal(nulled.statusCode, 200, 'null is not a value — it clears the key, nullable or not');

  // Nothing above was persisted.
  const now = await app.inject({ method: 'GET', url: '/settings', headers: H });
  assert.equal(json(now).data.spare_clones.source, 'default');
  assert.equal(json(now).data.git_fixer_provider.value, null, 'unset = inherit the coding agent');

  // And a good value still goes through.
  const good = await app.inject({ method: 'PATCH', url: '/settings', headers: H,
    payload: { bash_timeout_ms: 90000 } });
  assert.equal(good.statusCode, 200, good.body);
  const after = await app.inject({ method: 'GET', url: '/settings', headers: H });
  assert.equal(json(after).data.bash_timeout_ms.value, 90000);
  assert.equal(json(after).data.bash_timeout_ms.source, 'override');
  // null clears the override (nullable or not), back to the two-minute default.
  const cleared = await app.inject({ method: 'PATCH', url: '/settings', headers: H,
    payload: { bash_timeout_ms: null } });
  assert.equal(cleared.statusCode, 200, cleared.body);
  await app.inject({ method: 'DELETE', url: '/settings/bash_timeout_ms', headers: H });
});

// The launcher renders straight off these two payloads. Field names are the
// contract; a camelCase slip here is invisible to component tests and fatal at
// runtime, so assert the real responses satisfy the real row builder.
// ── POST /update — the remote upgrade trigger ────────────────────────────────
// The route only hands a tag to the updater sidecar through a shared directory;
// the sidecar (updater/watch.sh) does the rest. Without that directory the
// route must say so, never pretend.
test('POST /update: unavailable without a trigger dir, validates the tag, writes the request', async () => {
  const H = { authorization: 'Bearer test-key', 'content-type': 'application/json' };
  // The suite's app has no updateTriggerDir (a dev boot).
  let r = await app.inject({ method: 'POST', url: '/update', headers: H, payload: { tag: 'v1.2.3' } });
  assert.equal(r.statusCode, 503, r.body);
  assert.equal(JSON.parse(r.body).error.code, 'updater_unavailable');

  const trigger = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-trigger-'));
  const app2 = await buildApp({
    db, paths, apiKey: 'test-key', encryptionKey: Buffer.alloc(32, 9), version: 'test',
    pgPool, updateTriggerDir: trigger,
  });
  try {
    for (const bad of ['1.2.3', 'v1.2', 'v1.2.3-rc1', 'latest']) {
      r = await app2.inject({ method: 'POST', url: '/update', headers: H, payload: { tag: bad } });
      assert.equal(r.statusCode, 400, `${bad}: ${r.body}`);
      assert.equal(JSON.parse(r.body).error.code, 'invalid_args');
    }
    r = await app2.inject({ method: 'POST', url: '/update', headers: H, payload: { tag: 'v1.2.3' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), { ok: true, data: { tag: 'v1.2.3', requested: true } });
    assert.equal(await fs.readFile(path.join(trigger, 'request'), 'utf8'), 'v1.2.3\n');
    // Unauthenticated: refused like everything else.
    r = await app2.inject({ method: 'POST', url: '/update', payload: { tag: 'v1.2.3' } });
    assert.equal(r.statusCode, 401);
  } finally {
    await app2.close();
    await fs.rm(trigger, { recursive: true, force: true });
  }
});
