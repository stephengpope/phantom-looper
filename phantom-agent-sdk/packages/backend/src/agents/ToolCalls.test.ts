// ToolCalls.claim against fakes: one call id, one run — a repeated request
// for the id (a caller's retry) is answered what the first run answered,
// while it runs or after; a run that threw is forgotten. Run: npm test
// (tsx --test) in this package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCalls } from './ToolCalls.js';

const calls = () => new ToolCalls({} as never, {} as never);

test('claim: the same id is answered once, in flight or done', async () => {
  const tc = calls();
  let runs = 0;
  let finish!: (answer: { status: number; body: unknown }) => void;
  const slow = () => { runs++; return new Promise<{ status: number; body: unknown }>((resolve) => { finish = resolve; }); };

  const first = tc.claim('s1', 'toolu_1', slow);
  const repeat = tc.claim('s1', 'toolu_1', slow);          // while the first still runs
  finish({ status: 504, body: { ok: false, error: { code: 'exec_timeout' } } });
  assert.deepEqual(await first, { status: 504, body: { ok: false, error: { code: 'exec_timeout' } } });
  assert.deepEqual(await repeat, await first);
  const again = await tc.claim('s1', 'toolu_1', slow);     // after it is done
  assert.equal(again.status, 504);
  assert.equal(runs, 1, 'the tool ran once');

  // Another id, another session: their own runs.
  assert.equal((await tc.claim('s1', 'toolu_2', async () => ({ status: 200, body: 1 }))).body, 1);
  assert.equal((await tc.claim('s2', 'toolu_1', async () => ({ status: 200, body: 2 }))).body, 2);
});

test('claim: a run that threw is forgotten; forget() clears a session', async () => {
  const tc = calls();
  await assert.rejects(tc.claim('s1', 'toolu_1', async () => { throw new Error('boom'); }), /boom/);
  assert.equal((await tc.claim('s1', 'toolu_1', async () => ({ status: 200, body: 'ran' }))).body, 'ran');
  tc.forget('s1');
  assert.equal((await tc.claim('s1', 'toolu_1', async () => ({ status: 200, body: 'new turn' }))).body, 'new turn');
});

test('claim: only the last 32 ids are kept', async () => {
  const tc = calls();
  for (let i = 0; i < 33; i++) await tc.claim('s1', `id${i}`, async () => ({ status: 200, body: i }));
  assert.equal((await tc.claim('s1', 'id1', async () => ({ status: 200, body: 'again' }))).body, 1, 'the 32nd newest is kept');
  assert.equal((await tc.claim('s1', 'id0', async () => ({ status: 200, body: 'again' }))).body, 'again', 'the 33rd newest was dropped');
});
