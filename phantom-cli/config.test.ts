// The local half: the eight settings that stay on this machine, and the file
// they live in. Everything else is on the server (settings.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULTS, DESCRIPTIONS, META, LOCAL_KEYS, REMOTE_DEFAULTS, PROVIDER_KEY,
  isLocalKey, mask, visibleKeys, hiddenKeyCount, type ConfigKey,
} from './config.js';
import { resolveLocal, localValues, setLocal, clearLocal, readOverrides } from './local.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'settings.json');

test('every setting has a description and metadata', () => {
  for (const k of Object.keys(DEFAULTS) as ConfigKey[]) {
    assert.ok(DESCRIPTIONS[k], `${k} has a description`);
    assert.ok(META[k], `${k} has metadata`);
  }
});

test('the split is exhaustive and has no overlap: every key has exactly one home', () => {
  const local = new Set<string>(LOCAL_KEYS);
  const remote = new Set(Object.keys(REMOTE_DEFAULTS));
  for (const k of Object.keys(DEFAULTS)) {
    assert.equal(local.has(k) !== remote.has(k), true, `${k} lives in exactly one place`);
  }
  assert.equal(local.size + remote.size, Object.keys(DEFAULTS).length);
});

test('local holds only what cannot be right anywhere else', () => {
  // Two are how you REACH the server; five are facts about this machine. A
  // model choice is not either, so it is not here — every TUI is the same one.
  assert.deepEqual([...LOCAL_KEYS], [
    'server_url', 'server_key',
    'voice_mic_device', 'voice_speaker_device', 'voice_headphones',
    'voice_mic_muted', 'voice_speaker_muted',
  ]);
  for (const k of ['provider', 'model', 'reasoning', 'assistant_model', 'voice_wake_word']) {
    assert.equal(isLocalKey(k), false, `${k} belongs on the server`);
  }
});

test('the provider API keys are the server\'s, not this client\'s', () => {
  // They used to sit in this file, one per provider, and a second copy lived on
  // the server as auto_push_api_key. One key per provider, one place to set it.
  for (const k of Object.values(PROVIDER_KEY)) {
    assert.equal(k in DEFAULTS, false, `${k} is not a client setting`);
  }
  assert.equal(PROVIDER_KEY['openai-compatible'], 'openai_compatible_api_key');
  assert.notEqual(PROVIDER_KEY['openai-compatible'], PROVIDER_KEY.openai,
    'an OpenRouter key is not an OpenAI key');
});

test('defaults win when there is no file and no env', () => {
  const p = tmp();
  const { config } = resolveLocal(p, {});
  assert.equal(config.server_url.value, DEFAULTS.server_url);
  assert.equal(config.server_url.source, 'default');
  assert.equal(config.voice_headphones.value, false);
});

test('file beats default, env beats file, and the source says which', () => {
  const p = tmp();
  setLocal('server_url', 'http://saved:8080', p);
  let { config } = resolveLocal(p, {});
  assert.equal(config.server_url.value, 'http://saved:8080');
  assert.equal(config.server_url.source, 'file');

  ({ config } = resolveLocal(p, { PHANTOM_BACKEND_URL: 'http://env:9090' }));
  assert.equal(config.server_url.value, 'http://env:9090');
  assert.equal(config.server_url.source, 'env');
  assert.equal(config.server_url.envVar, 'PHANTOM_BACKEND_URL');
});

test('env reaches ONLY the local keys, so nothing in a shell can shadow the server', () => {
  const p = tmp();
  const withEnv = { ANTHROPIC_API_KEY: 'sk-shell', PHANTOM_CLI_MODEL: 'from-shell' };
  const { config } = resolveLocal(p, withEnv);
  assert.equal('model' in config, false, 'model is not local, so PHANTOM_CLI_MODEL does not reach it');
  for (const k of LOCAL_KEYS) {
    if (k === 'server_url' || k === 'server_key') continue;
    assert.equal(config[k].source !== 'env', true, `${k} has no env override`);
  }
});

test('env var precedence within one key is most-specific-first', () => {
  const p = tmp();
  const { config } = resolveLocal(p, { PHANTOM_BACKEND_KEY: 'first', API_KEY: 'second' });
  assert.equal(config.server_key.value, 'first');
  assert.equal(config.server_key.envVar, 'PHANTOM_BACKEND_KEY');
});

test('the file holds ONLY what changed, so untouched keys follow the default', () => {
  const p = tmp();
  setLocal('voice_headphones', true, p);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { voice_headphones: true });
});

test('clear removes the override, it does not write the default', () => {
  const p = tmp();
  setLocal('server_url', 'http://x', p);
  clearLocal('server_url', p);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), {});
  assert.equal(localValues(p, {}).server_url, DEFAULTS.server_url);
});

test('the file is 0600 even if it already existed as 0644', () => {
  const p = tmp();
  fs.writeFileSync(p, '{}', { mode: 0o644 });
  fs.chmodSync(p, 0o644);
  setLocal('server_key', 'sk-secret', p);
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});

test('a corrupt file is reported and NEVER overwritten', () => {
  const p = tmp();
  fs.writeFileSync(p, '{ not json');
  const { overrides, error } = readOverrides(p);
  assert.deepEqual(overrides, {});
  assert.match(error ?? '', /not valid JSON/);
  assert.equal(setLocal('server_url', 'http://x', p), error, 'the write refuses and says why');
  assert.equal(fs.readFileSync(p, 'utf8'), '{ not json', 'untouched');
});

test('keys that moved to the server are ignored in the file, not crashed on', () => {
  // An older TUI wrote its model and its Anthropic key here. Reading is not the
  // moment to delete them: a downgrade would want them back.
  const p = tmp();
  fs.writeFileSync(p, JSON.stringify({ server_url: 'http://x', model: 'old', anthropic_key: 'sk-old' }));
  const { overrides } = readOverrides(p);
  assert.deepEqual(overrides, { server_url: 'http://x' });
  assert.equal(fs.readFileSync(p, 'utf8').includes('sk-old'), true, 'left alone on disk');
});

test('validation rejects bad values before they reach disk', () => {
  const p = tmp();
  assert.match(setLocal('voice_headphones', 'yes' as never, p) ?? '', /true or false/);
  assert.equal(fs.existsSync(p), false, 'nothing written');
});

test('secrets are shown as their last four, and absence is honest', () => {
  assert.equal(mask(null), 'not set');
  assert.equal(mask(''), 'not set');
  assert.equal(mask('sk-abcdefgh'), '••••efgh');
  assert.equal(mask('abc'), '••••');
});

test('only the active provider\'s key is visible, and hidden ones are counted', () => {
  const cfg = { provider: 'anthropic', base_url: null,
    anthropic_api_key: 'a', openai_api_key: 'b', google_api_key: null } as never;
  assert.equal(hiddenKeyCount(cfg), 1, 'the openai key is stored but not in use');
  assert.equal(visibleKeys(cfg).includes('base_url'), false, 'anthropic ignores base_url');
});

test('openai-compatible reveals base_url', () => {
  const cfg = { provider: 'openai-compatible', base_url: 'http://x' } as never;
  assert.equal(visibleKeys(cfg).includes('base_url'), true);
});

test('no provider yet: no key is in use, so every stored one counts as hidden', () => {
  const cfg = { provider: null, anthropic_api_key: 'a', openai_api_key: 'b', google_api_key: null } as never;
  assert.equal(hiddenKeyCount(cfg), 2);
});
