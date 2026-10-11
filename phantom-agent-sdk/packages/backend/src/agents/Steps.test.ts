// Steps against fakes: a step is written once, whole, and never otherwise.
// Run: npm test (tsx --test) in this package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Steps, type StepOpening } from './Steps.js';
import type { Sessions } from '../storage/Sessions.js';
import type { SessionEvents } from './SessionEvents.js';
import type { TranscriptLine } from '@phantom-agent-sdk/client/transcript';

/** A session held by `holder`, whose record is `lines`. */
function world(holder: string | null = 'cli') {
  const lines: TranscriptLine[] = [];
  const parts: unknown[] = [];
  const sessions = {
    get: async () => ({ id: 's1', lockedBy: holder, transcriptLines: lines.length }),
    appendTranscript: async (_session: unknown, _client: string, body: { lines: TranscriptLine[] }) => {
      lines.push(...body.lines);
      return { lines: lines.length, applied: true, stamp: new Date() };
    },
  } as unknown as Sessions;
  const events = { publishPart: (_id: string, _by: string, part: unknown) => { parts.push(part); } } as unknown as SessionEvents;
  return { steps: new Steps(sessions, events), lines, parts };
}

const roles = (lines: TranscriptLine[]) => lines.map((line) => (line.type === 'message' ? line.message.role : line.type));
const usage = { provider: 'openai', model: 'mock', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const toolMessage = (toolCallId: string) => ({ role: 'tool' as const, content: [{ type: 'tool-result' as const, toolCallId, toolName: 'look', output: { type: 'json' as const, value: { ok: true } } }] });
const answerWithCalls = (ids: string[]): StepOpening => ({
  drivers: [{ role: 'user', content: 'go' }],
  assistant: { role: 'assistant', content: ids.map((toolCallId) => ({ type: 'tool-call' as const, toolCallId, toolName: 'look', input: {} })) },
  usage, calls: ids.map((toolCallId) => ({ toolCallId, toolName: 'look' })),
});

test('an answer with no call is written at once: drivers, answer, usage', async () => {
  const { steps, lines } = world();
  const written = await steps.open('s1', 'cli', { drivers: [{ role: 'user', content: 'hi' }], assistant: { role: 'assistant', content: 'hello' }, usage, calls: [] });
  assert.ok(written);
  assert.deepEqual(roles(lines), ['user', 'assistant', 'usage']);
  assert.equal(written.count, 3);
  assert.ok(!steps.isOpen('s1'));
});

test('a step is held until every call is answered, then written whole, results in call order', async () => {
  const { steps, lines } = world();
  assert.equal(await steps.open('s1', 'cli', answerWithCalls(['a', 'b'])), null);
  assert.ok(steps.isOpen('s1'));
  assert.deepEqual(lines, [], 'nothing written while a call is open');
  assert.equal(await steps.results('s1', 'cli', [{ toolCallId: 'b', toolName: 'look', message: toolMessage('b') }]), null);
  const written = await steps.serverResult('s1', 'cli', { toolCallId: 'a', toolName: 'look', input: {} }, { ok: true });
  assert.ok(written);
  assert.deepEqual(roles(lines), ['user', 'assistant', 'usage', 'tool', 'tool']);
  const ids = lines.filter((line) => line.type === 'message' && line.message.role === 'tool').map((line) => (line as { message: { content: Array<{ toolCallId: string }> } }).message.content[0].toolCallId);
  assert.deepEqual(ids, ['a', 'b'], 'in the order the calls were made, not answered');
});

test('the first result for a call is the call\'s: a second is ignored', async () => {
  const { steps, lines } = world();
  await steps.open('s1', 'cli', answerWithCalls(['a']));
  await steps.serverResult('s1', 'cli', { toolCallId: 'a', toolName: 'look', input: {} }, { ok: true, first: true });
  assert.equal(JSON.stringify(lines).includes('"first":true'), true);
  assert.equal(await steps.results('s1', 'cli', [{ toolCallId: 'a', toolName: 'look', message: toolMessage('a') }]), null, 'no step to add to');
  assert.equal(lines.length, 4);
});

test('a result for a call the answer did not make is dropped', async () => {
  const { steps, lines } = world();
  await steps.open('s1', 'cli', answerWithCalls(['a']));
  assert.equal(await steps.results('s1', 'cli', [{ toolCallId: 'zzz', toolName: 'look', message: toolMessage('zzz') }]), null);
  assert.ok(steps.isOpen('s1'));
  assert.deepEqual(lines, []);
});

test('close: the truth in one write — results in hand, interrupted for the rest, an interrupted line', async () => {
  const { steps, lines } = world();
  await steps.open('s1', 'cli', answerWithCalls(['a', 'b']));
  await steps.results('s1', 'cli', [{ toolCallId: 'a', toolName: 'look', message: toolMessage('a') }]);
  const written = await steps.close('s1', 'cli', null);
  assert.ok(written);
  assert.deepEqual(roles(lines), ['user', 'assistant', 'usage', 'tool', 'tool', 'interrupted']);
  assert.ok(JSON.stringify(lines[4]).includes('interrupted before this call'));
  assert.ok(!steps.isOpen('s1'));
});

test('close with an answer the api never got (cut mid reply): written once, no usage line', async () => {
  const { steps, lines } = world();
  const written = await steps.close('s1', 'cli', { drivers: [{ role: 'user', content: 'go' }], assistant: { role: 'assistant', content: 'half a thou' }, calls: [] });
  assert.ok(written);
  assert.deepEqual(roles(lines), ['user', 'assistant', 'interrupted']);
});

test('close with nothing open and nothing to open writes nothing', async () => {
  const { steps, lines } = world();
  assert.equal(await steps.close('s1', 'cli', null), null);
  assert.deepEqual(lines, []);
});

test('a second open while one is open closes the first as interrupted first', async () => {
  const { steps, lines } = world();
  await steps.open('s1', 'cli', answerWithCalls(['a']));
  const written = await steps.open('s1', 'cli', { drivers: [], assistant: { role: 'assistant', content: 'next' }, usage, calls: [] });
  assert.ok(written);
  assert.deepEqual(roles(lines), ['user', 'assistant', 'usage', 'tool', 'interrupted', 'assistant', 'usage']);
});

test('hand-off: the driver\'s own open calls close as interrupted; the api\'s running call is waited for; the step is written whole', async () => {
  const { steps, lines, parts } = world('runner');   // the hold moved to the runner already
  await steps.open('s1', 'cli', answerWithCalls(['mine', 'server']));
  const end = steps.begin('s1', 'server');
  let handedOff = false;
  const waiting = steps.handoff('s1').then(() => { handedOff = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(handedOff, false, 'waits for the running server tool');
  assert.deepEqual(lines, []);
  await steps.serverResult('s1', 'cli', { toolCallId: 'server', toolName: 'look', input: {} }, { ok: true });
  end();
  await waiting;
  assert.deepEqual(roles(lines), ['user', 'assistant', 'usage', 'tool', 'tool']);
  assert.ok(JSON.stringify(lines[3]).includes('interrupted before this call'), 'the driver\'s call: interrupted');
  assert.equal(parts.length, 1, 'the departed driver relays nothing, so the api sent the result down the feed');
});

test('nobody holds the session: the step is not recorded', async () => {
  const { steps, lines } = world(null);
  assert.equal(await steps.open('s1', 'cli', { drivers: [], assistant: { role: 'assistant', content: 'x' }, usage, calls: [] }), null);
  assert.deepEqual(lines, []);
});

test('claim: the same id is answered once, in flight or done', async () => {
  const { steps } = world();
  let runs = 0;
  const run = async () => { runs++; await new Promise((resolve) => setTimeout(resolve, 10)); return { status: 200, body: { ok: true } }; };
  const [a, b] = await Promise.all([steps.claim('s1', 'c1', run), steps.claim('s1', 'c1', run)]);
  assert.equal(runs, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(await steps.claim('s1', 'c1', run), a);
  assert.equal(runs, 1);
});

test('claim: a run that threw is forgotten; forget() clears a session', async () => {
  const { steps } = world();
  await assert.rejects(steps.claim('s1', 'c2', async () => { throw new Error('boom'); }));
  const again = await steps.claim('s1', 'c2', async () => ({ status: 200, body: {} }));
  assert.equal(again.status, 200);
  steps.forget('s1');
  let runs = 0;
  await steps.claim('s1', 'c2', async () => { runs++; return { status: 200, body: {} }; });
  assert.equal(runs, 1);
});
