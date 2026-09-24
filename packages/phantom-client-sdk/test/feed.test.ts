// The session feed: the turn is relayed live, a remote stop ends it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestAgent, harness } from './testAgent.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('every turn is relayed to the session feed: turn-start, parts in order, turn-end', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'hello there', tools: [{ name: 'echo', input: { text: 'x' } }] }, { text: 'done' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  await a.say('hi');
  const relayed = h.fake.sessions.get(a.sessionId)!.relayed;
  assert.equal(relayed[0]!.event, 'turn-start');
  assert.equal(relayed[0]!.agent, 'coding');
  assert.equal(relayed[0]!.message, 'hi');
  assert.equal(relayed[0]!.model, 'claude-test');
  assert.equal(relayed[relayed.length - 1]!.event, 'turn-end');
  const parts = relayed.filter((e) => e.event === 'part').map((e) => (e.part as { type: string }).type);
  assert.ok(parts.includes('text-delta') && parts.includes('tool-result'));
  // Batched: far fewer requests than parts.
  const posts = h.fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/events'));
  assert.ok(posts.length < parts.length);
  // turn-end went out before turn-ended was called, so a watcher sees the turn close first.
  const order = h.fake.requests.filter((r) => r.path.endsWith('/events') || r.path.endsWith('/turn-ended')).map((r) => r.path.split('/').pop());
  assert.equal(order[order.length - 1], 'turn-ended');
  assert.deepEqual(h.errors, []);
});

test('a stop published on the feed by someone else interrupts the running turn', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'one two three four five six seven', chunkDelayMs: 40 }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  const p = a.say('go');
  await wait(120);
  h.fake.publishInterrupt(a.sessionId);
  const r = await p;
  assert.equal(r?.outcome, 'interrupted');
  assert.equal(h.fake.sessions.get(a.sessionId)!.watchers.size, 0);   // unsubscribed at turn end
  assert.deepEqual(h.errors, []);
});

test('a transport that cannot stream never opens the feed; the relay still runs', async () => {
  const h = harness();
  h.fake.backend.canStream = false;
  TestAgent.script = [{ text: 'fine' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  await a.say('hi');
  assert.equal(h.fake.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/events')).length, 0);
  assert.ok(h.fake.sessions.get(a.sessionId)!.relayed.length > 2);
});

test('a relay failure is one notice, never an error, and the turn completes', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'fine' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  // Make the relay route refuse: a different lock holder is what the route checks.
  const origFetch = h.fake.backend.fetch!;
  h.fake.backend.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (init?.method === 'POST' && url.endsWith('/events')) {
      return Promise.resolve(new Response(JSON.stringify({ ok: false, error: { code: 'nope', message: 'relay down' } }), { status: 500, headers: { 'content-type': 'application/json' } }));
    }
    return origFetch(input, init);
  };
  const b = await TestAgent.resume(h.fake.backend, h.handlers, a.sessionId);
  const r = await b.say('hi');
  assert.equal(r?.outcome, 'done');
  assert.deepEqual(h.errors, []);
  assert.equal(h.notices.filter((n) => n.kind === 'info' && /relay stopped/.test(n.text)).length, 1);
});

test('the row is re-read at turn start: plan mode on the row makes mutating tools refuse', async () => {
  const h = harness();
  TestAgent.script = [{ tools: [{ name: 'write_note', input: { text: 'n' } }] }, { text: 'ok' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  h.fake.sessions.get(a.sessionId)!.planMode = true;
  await a.say('go');
  const toolLine = h.fake.linesOf(a.sessionId).find((l) => l.type === 'message' && (l.message as { role: string }).role === 'tool')!;
  const out = (toolLine.message as { content: Array<{ output: { value: { error: { code: string } } } }> }).content[0]!.output.value;
  assert.equal(out.error.code, 'readonly');
});

test('the provider saying the context is too long is its own error code', async () => {
  const h = harness();
  TestAgent.script = [{ error: new Error('prompt is too long: 210000 tokens > 200000 maximum') }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  await assert.rejects(a.say('hi'), (e: Error & { code: string }) => e.code === 'context_too_long');
});
