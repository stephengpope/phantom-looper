// The model catalog (phantom-backend/models.ts) without a network: models.dev's
// shape → ours, newest first; the snapshot answering when models.dev cannot;
// "latest" as the model default. The harness points MODELS_DEV_API_BASE at
// an address nothing listens on, so a refresh fails fast and the committed
// snapshot answers.
import './harness.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromModelsDev, latestModel, modelsFor, catalog, refreshCatalog, resetCatalog, CATALOG_PROVIDERS } from '../phantom-backend/models.js';

test('fromModelsDev: the three providers, each newest first, ids as the tie-break', () => {
  const c = fromModelsDev({
    anthropic: { models: {
      'claude-b': { name: 'B', release_date: '2026-01-01' },
      'claude-a': { name: 'A', release_date: '2026-01-01', reasoning: true },
      'claude-old': { name: 'Old', release_date: '2025-06-01' },
      'claude-undated': { name: 'Undated' },
    } },
    openai: { models: { 'gpt-x': { name: 'X', release_date: '2026-03-03' } } },
    // google absent; a provider models.dev does not know is dropped
    mistral: { models: { m: { name: 'm' } } },
  });
  assert.deepEqual(Object.keys(c), [...CATALOG_PROVIDERS]);
  assert.deepEqual(c.anthropic.map((m) => m.id), ['claude-a', 'claude-b', 'claude-old', 'claude-undated']);
  assert.deepEqual(c.anthropic[0], { id: 'claude-a', name: 'A', reasoning: true, releaseDate: '2026-01-01' });
  assert.equal(c.anthropic[3].releaseDate, '', 'no date is the empty string, sorted last');
  assert.deepEqual(c.google, []);
});

test('offline: the snapshot answers, a failed refresh changes nothing, and latest is its first row', async () => {
  resetCatalog();
  const { source, catalog: snap } = catalog();
  assert.equal(source, 'snapshot');
  assert.ok(snap.anthropic.length > 0, 'the committed snapshot has models');
  await refreshCatalog();   // models.dev "down" (the harness seam): swallowed
  assert.equal(catalog().source, 'snapshot');
  assert.equal(latestModel('anthropic'), snap.anthropic[0].id);
  assert.deepEqual(modelsFor('openai-compatible'), [], 'no catalog for an endpoint');
  assert.deepEqual(modelsFor('nope'), []);
  assert.equal(latestModel(null), null);
  assert.equal(latestModel('openai-compatible'), null);
});

test('live: a fetch that answers replaces the snapshot and is what latest reads', async () => {
  resetCatalog();
  const f = (async () => new Response(JSON.stringify({
    anthropic: { models: { 'claude-new': { name: 'New', release_date: '2027-01-01' }, 'claude-x': { name: 'X', release_date: '2020-01-01' } } },
  }))) as unknown as typeof fetch;
  await refreshCatalog(f);
  assert.equal(catalog().source, 'live');
  assert.equal(latestModel('anthropic'), 'claude-new');
  assert.deepEqual(modelsFor('openai'), [], 'live answer wins whole, even where it is emptier than the snapshot');
  resetCatalog();
});
