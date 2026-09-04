// The models.dev catalog: what /model's picker reads. Invariants that hold
// whatever the source (bundled snapshot or a per-user cache), so the test is
// deterministic without touching the network or ~/.phantom-cli.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelsFor, CATALOG_PROVIDERS } from './modelCatalog.js';

test('openai-compatible is not a catalog provider (arbitrary endpoints)', () => {
  assert.ok(!CATALOG_PROVIDERS.includes('openai-compatible' as never));
  assert.deepEqual(modelsFor('openai-compatible'), []);
});

test('unknown providers yield nothing, never throw', () => {
  assert.deepEqual(modelsFor('bogus'), []);
  assert.deepEqual(modelsFor(''), []);
});

test('anthropic returns id-sorted models with id + label + reasoning', () => {
  const list = modelsFor('anthropic');
  assert.ok(list.length > 0, 'expected a non-empty anthropic catalog');
  for (const m of list) {
    assert.equal(typeof m.id, 'string');
    assert.ok(m.id.length > 0);
    assert.equal(typeof m.label, 'string');
    assert.equal(typeof m.reasoning, 'boolean');
  }
  const ids = list.map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort(), 'catalog must be id-sorted');
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
});
