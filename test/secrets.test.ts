// Secrets: the settings table's `secret` namespace and the /secrets routes.
// Real Postgres, no Docker, no git — secrets are pure DB + routes. The one
// thing this suite must never let regress: the namespace WALL — a user
// secret named `github_token` must not shadow the credential of the same
// name (readStore filters namespace, or the agent's git runs on a user's
// made-up token).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testDb } from './harness.js';
import { makePaths } from '../phantom-backend/pool/paths.js';
import { buildApp } from '../phantom-backend/api/app.js';
import {
  readStore, putScoped, listSecrets, readSecretValue, putSecret, dropSecret,
  GLOBAL, workspaceScope,
} from '../phantom-backend/store.js';
import { resolveCredential } from '../phantom-backend/settings.js';

let db: Awaited<ReturnType<typeof testDb>>['db'];
let pgPool: Awaited<ReturnType<typeof testDb>>['pool'];
let app: Awaited<ReturnType<typeof buildApp>>;
let root: string;
let wsId: string;

const KEY = Buffer.alloc(32, 9);
const H = { authorization: 'Bearer test-key' };
const json = (r: { body: string }) => JSON.parse(r.body);

before(async () => {
  ({ db, pool: pgPool } = await testDb('secrets'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-secrets-'));
  app = await buildApp({
    db, paths: makePaths(path.join(root, 'workspaces')), apiKey: 'test-key',
    encryptionKey: KEY, version: 'test', pgPool,
  });
  const r = await app.inject({ method: 'POST', url: '/workspaces', headers: H,
    payload: { url: 'https://github.com/acme/widgets.git' } });
  assert.equal(r.statusCode, 201, r.body);
  wsId = json(r).data.id;
});

after(async () => {
  await app?.close();
  await pgPool?.end();
  await fs.rm(root, { recursive: true, force: true });
});

test('the namespace wall: a secret named github_token never shadows the credential', async () => {
  await putScoped(db, KEY, GLOBAL, 'github_token', 'ghp_real', true);
  await putSecret(db, KEY, GLOBAL, 'github_token', 'an imposter', 'ghp_fake');
  assert.equal(await resolveCredential(db, KEY, 'github_token'), 'ghp_real',
    'the credential chain reads the general namespace only');
  const plain = await readStore(db, null, [GLOBAL]);
  assert.equal(plain.get(GLOBAL)?.get('github_token'), undefined,
    'settings reads see neither half of a secret row');
  assert.equal(await readSecretValue(db, KEY, 'github_token', [GLOBAL]), 'ghp_fake',
    'the secret itself still reads back through its own door');
  await dropSecret(db, GLOBAL, 'github_token');
  assert.equal(await resolveCredential(db, KEY, 'github_token'), 'ghp_real',
    'deleting the secret leaves the credential standing');
});

test('store: one row per secret — listing never decrypts, workspace wins the value', async () => {
  await putSecret(db, KEY, GLOBAL, 'stripe_key', 'Stripe live key', 'sk_live_global');
  await putSecret(db, KEY, workspaceScope(wsId), 'stripe_key', 'this workspace\'s Stripe', 'sk_live_ws');
  await putSecret(db, KEY, GLOBAL, 'alpha', '', 'a');
  const both = await listSecrets(db, [GLOBAL, workspaceScope(wsId)]);
  assert.deepEqual(both.map((s) => [s.name, s.scope]), [
    ['alpha', GLOBAL], ['stripe_key', GLOBAL], ['stripe_key', workspaceScope(wsId)]],
  'global first then by name; the same name at both layers lists twice');
  assert.equal(both[1].description, 'Stripe live key', 'descriptions ride the plain column');
  assert.equal(await readSecretValue(db, KEY, 'stripe_key', [GLOBAL, workspaceScope(wsId)]),
    'sk_live_ws', 'most specific wins');
  assert.equal(await readSecretValue(db, KEY, 'stripe_key', [GLOBAL]), 'sk_live_global');
  assert.equal(await readSecretValue(db, KEY, 'nope', [GLOBAL]), undefined);
  // Overwrite is the update path: same scope, same name, new value + description.
  await putSecret(db, KEY, GLOBAL, 'alpha', 'now described', 'a2');
  assert.equal(await readSecretValue(db, KEY, 'alpha', [GLOBAL]), 'a2');
  assert.equal((await listSecrets(db, [GLOBAL])).find((s) => s.name === 'alpha')?.description, 'now described');
});

test('routes: PUT validates the name and requires a value; list carries layers; GET cascades', async () => {
  const bad = await app.inject({ method: 'PUT', url: '/secrets/Bad-Name', headers: H,
    payload: { value: 'x' } });
  assert.equal(bad.statusCode, 400);
  assert.match(json(bad).error.message, /lowercase letters, digits and underscores/);
  const noVal = await app.inject({ method: 'PUT', url: '/secrets/ok_name', headers: H, payload: {} });
  assert.equal(noVal.statusCode, 400);
  assert.match(json(noVal).error.message, /value.*required/);
  const badWs = await app.inject({ method: 'PUT', url: '/secrets/ok_name?workspace=nope', headers: H,
    payload: { value: 'x' } });
  assert.equal(badWs.statusCode, 404, 'a typo\'d workspace refuses rather than storing a dead row');

  const put = await app.inject({ method: 'PUT', url: '/secrets/deploy_token', headers: H,
    payload: { description: 'deploys the site', value: 'tok_g' } });
  assert.equal(put.statusCode, 200, put.body);
  const putWs = await app.inject({ method: 'PUT', url: `/secrets/deploy_token?workspace=${wsId}`, headers: H,
    payload: { description: 'this repo\'s deploy', value: 'tok_w' } });
  assert.equal(putWs.statusCode, 200);

  const list = await app.inject({ method: 'GET', url: `/secrets?workspace=${wsId}`, headers: H });
  const rows = json(list).data.secrets as Array<{ name: string; scope: string; description: string }>;
  const dep = rows.filter((s) => s.name === 'deploy_token');
  assert.deepEqual(dep.map((s) => s.scope), ['global', 'workspace'], 'both layers, tagged');
  assert.ok(rows.every((s) => !JSON.stringify(s).includes('tok_')), 'the list never carries a value');

  // The bare list is EVERY layer — the cli saves to any workspace, so it
  // must see every workspace's rows, each carrying its workspace id.
  const all = await app.inject({ method: 'GET', url: '/secrets', headers: H });
  const allRows = json(all).data.secrets as Array<{ name: string; scope: string; workspace?: string }>;
  const wsRow = allRows.find((s) => s.name === 'deploy_token' && s.scope === 'workspace');
  assert.equal(wsRow?.workspace, wsId, 'workspace rows name their workspace');
  assert.ok(allRows.some((s) => s.name === 'deploy_token' && s.scope === 'global'));

  const g = await app.inject({ method: 'GET', url: `/secrets/deploy_token?workspace=${wsId}`, headers: H });
  assert.equal(json(g).data.value, 'tok_w', 'workspace wins');
  const gGlobal = await app.inject({ method: 'GET', url: '/secrets/deploy_token', headers: H });
  assert.equal(json(gGlobal).data.value, 'tok_g', 'no workspace = the global layer');

  const miss = await app.inject({ method: 'GET', url: '/secrets/absent', headers: H });
  assert.equal(miss.statusCode, 404);
  assert.match(json(miss).error.message, /deploy_token/, 'an unknown name answers with the names that exist');
});

test('migration 010 upgrades a table that already holds rows — settings and credentials intact', async () => {
  const { migrate } = await import('../phantom-backend/db/migrate.js');
  const pre = await testDb('secrets_upgrade', { upTo: '009_plan_mode.sql' });
  try {
    // Rows written by the PRE-namespace code: a plain override and an
    // encrypted credential, exactly as a live install holds them.
    await pre.pool.query(
      `insert into phantom_looper.settings (scope, key, value) values ('global', 'spare_clones', '5'::jsonb)`);
    const { encrypt } = await import('../phantom-backend/crypto.js');
    await pre.pool.query(
      `insert into phantom_looper.settings (scope, key, value_enc, secret) values ('global', 'github_token', $1, true)`,
      [encrypt(KEY, 'ghp_upgraded')]);
    await migrate(pre.pool);
    const upgraded = await readStore(pre.db, KEY, [GLOBAL]);
    assert.equal(upgraded.get(GLOBAL)?.get('spare_clones')?.value, 5, 'the override survives in general');
    assert.equal(upgraded.get(GLOBAL)?.get('github_token')?.value, 'ghp_upgraded', 'the credential decrypts');
    await putSecret(pre.db, KEY, GLOBAL, 'post_upgrade', 'works', 'v');
    assert.equal(await readSecretValue(pre.db, KEY, 'post_upgrade', [GLOBAL]), 'v');
  } finally { await pre.pool.end(); }
});

test('routes: DELETE removes one layer only; the other survives', async () => {
  const delWs = await app.inject({ method: 'DELETE', url: `/secrets/deploy_token?workspace=${wsId}`, headers: H });
  assert.equal(delWs.statusCode, 200);
  const g = await app.inject({ method: 'GET', url: `/secrets/deploy_token?workspace=${wsId}`, headers: H });
  assert.equal(json(g).data.value, 'tok_g', 'the global secret shows through again');
  const again = await app.inject({ method: 'DELETE', url: `/secrets/deploy_token?workspace=${wsId}`, headers: H });
  assert.equal(again.statusCode, 404, 'nothing left at that layer');
  await app.inject({ method: 'DELETE', url: '/secrets/deploy_token', headers: H });
  const gone = await app.inject({ method: 'GET', url: '/secrets/deploy_token', headers: H });
  assert.equal(gone.statusCode, 404);
});
