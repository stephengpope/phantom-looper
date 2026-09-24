import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestAgent, harness } from './testAgent.js';
import { conversationFrom, parseLines } from '../src/transcript.js';
import { planCompaction, fastStrategy, compactionDue } from '../src/compaction.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('compaction appends one line, replaces the in-memory prefix, and loads back the same way', async () => {
  const h = harness();
  // Four turns, then the summary call (the scripted model serves both roles here).
  TestAgent.script = [{ text: 'r1' }, { text: 'r2' }, { text: 'r3' }, { text: 'r4' }, { text: '## Objective\n- the summary' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  for (const t of ['a', 'b', 'c', 'd']) await a.say(t);
  assert.equal(a.messages.length, 8);
  const r = await a.compact();
  assert.ok(r);
  assert.equal(r.removed, 4);   // 50% of 8 user+assistant messages
  const lines = h.fake.linesOf(a.sessionId);
  const comp = lines.filter((l) => l.type === 'compaction');
  assert.equal(comp.length, 1);
  assert.equal(lines.length, 13);   // 12 + the compaction line; nothing rewritten
  assert.equal(a.messages.length, 5);
  assert.equal((a.messages[0] as { content: string }).content, '## Objective\n- the summary');
  assert.equal((a.messages[1] as { content: string }).content, 'c');
  // Loading from the record gives the same conversation.
  const loaded = conversationFrom(parseLines(h.fake.sessions.get(a.sessionId)!.lines.join('\n')));
  assert.deepEqual(loaded.messages, a.messages);
  assert.ok(h.notices.some((n) => n.kind === 'compacted'));
  assert.deepEqual(h.errors, []);
});

test('auto-compaction fires after a turn whose input crossed the threshold', async () => {
  const h = harness();
  (h.fake.agentConfig as { compaction: { contextWindow: number; thresholdPct: number } }).compaction = {
    ...(h.fake.agentConfig as { compaction: object }).compaction, contextWindow: 1000, thresholdPct: 50 };
  TestAgent.script = [{ text: 'r1' }, { text: 'r2', usage: { input: 900, output: 5 } }, { text: 'summary text' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  await a.say('a');
  await a.say('b');
  await wait(100);
  assert.equal(h.fake.linesOf(a.sessionId).filter((l) => l.type === 'compaction').length, 1);
  assert.deepEqual(h.errors, []);
});

test('planCompaction: too little to compact is null; a prior summary is folded in', () => {
  assert.equal(planCompaction([{ role: 'user', content: 'x' }], fastStrategy, 50, null), null);
  const plan = planCompaction([
    { role: 'user', content: 'PRIOR' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' },
  ], fastStrategy, 50, 'PRIOR');
  assert.ok(plan);
  assert.equal(plan.removeCount, 3);
  assert.match(plan.prompt, /<prior-summary>\nPRIOR/);
  assert.match(plan.prompt, /\[User\]: a/);
});

test('compactionDue', () => {
  assert.equal(compactionDue(800, 1000, 80), true);
  assert.equal(compactionDue(799, 1000, 80), false);
  assert.equal(compactionDue(800, null, 80), false);
  assert.equal(compactionDue(800, 1000, 0), false);
});
