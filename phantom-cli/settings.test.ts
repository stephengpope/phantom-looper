// The server half: what the cli reads and writes over the ONE settings store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeSettings, isCredential, CREDENTIAL_KEYS } from './settings.js';

const wrap = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));

function fakeApi(stored: Record<string, unknown>) {
  const calls: string[] = [];
  const api = async (method: string, p: string, body?: unknown) => {
    calls.push(`${method} ${p}${body ? ` ${JSON.stringify(body)}` : ''}`);
    if (method === 'GET') return wrap(stored);
    return { ok: true };
  };
  return { api, calls };
}

test('a read is ONE call to the flat store, values taken as resolved', async () => {
  const { api, calls } = fakeApi({
    model: 'claude-opus-5', reasoning: 'high',
    anthropic_api_key: 'sk-ant', github_token: 'ghp', spare_clones: 4,
  });
  const cfg = await makeSettings(api).read();
  assert.equal(cfg.model, 'claude-opus-5');
  assert.equal(cfg.reasoning, 'high');
  assert.equal(cfg.anthropic_api_key, 'sk-ant');
  assert.equal(cfg.github_token, 'ghp');
  // One store now — the server's own settings ride along; the client just
  // does not render the ones it has no screen for.
  assert.equal(cfg.spare_clones, 4);
  assert.deepEqual(calls, ['GET /settings']);
});

test('an unreachable server THROWS — it never invents values', async () => {
  const api = async () => { throw new Error('connect ECONNREFUSED'); };
  await assert.rejects(() => makeSettings(api).read(), /ECONNREFUSED/);
});

test('writes go to the one store — no namespace routing to get wrong', async () => {
  const { api, calls } = fakeApi({});
  await makeSettings(api).write('model', 'claude-sonnet-5');
  await makeSettings(api).write('anthropic_api_key', 'sk-new');
  assert.deepEqual(calls, [
    'PATCH /settings {"model":"claude-sonnet-5"}',
    'PATCH /settings {"anthropic_api_key":"sk-new"}',
  ]);
});

test('null clears, and it is sent as null rather than as an empty string', async () => {
  const { api, calls } = fakeApi({});
  await makeSettings(api).write('base_url', null);
  assert.deepEqual(calls, ['PATCH /settings {"base_url":null}']);
});

test('the credential list is the seven the server holds, one key per provider', () => {
  assert.deepEqual([...CREDENTIAL_KEYS], [
    'github_token',
    'anthropic_api_key', 'openai_api_key', 'google_api_key', 'openai_compatible_api_key',
    'deepgram_api_key', 'firecrawl_api_key',
  ]);
  assert.equal(isCredential('anthropic_api_key'), true);
  assert.equal(isCredential('model'), false);
});

// ── the rule that keeps this from coming back ───────────────────────────────

/** Every source file under cli/, tests aside. */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'sidecar') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

test('settings.ts is the ONLY door to the settings API', () => {
  // The bug this pins: /keys wrote straight to the API, so nothing re-read and
  // the Assistant kept spawning with the env it was born with — you had to
  // switch voice off and on to get a second attempt. One door means a write
  // cannot skip whatever a read would have picked up.
  // commands.ts holds the SLASH-COMMAND names ('/settings' the screen), which
  // share the literal with the API path — the one legitimate look-alike.
  const offenders = sources(new URL('.', import.meta.url).pathname)
    .filter((f) => !f.endsWith('/settings.ts') && !f.endsWith('/commands.ts'))
    .filter((f) => /['`]\/settings\b/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'these reach /settings directly — go through settings.ts');
});

test('nothing hands out a settings object to hold', () => {
  // A resolved bag of values is a cache by another name: whatever takes one
  // keeps using it long after the store has moved on. `read()` exists to be
  // called at the point of use, so the exports are a client and its constants
  // — never a value.
  const src = readFileSync(new URL('settings.ts', import.meta.url).pathname, 'utf8');
  assert.equal(/export const (?!CREDENTIAL_KEYS|isCredential)/.test(src), false,
    'settings.ts exports a client and its constants, not resolved values');
});
