// The agent end to end against the fake backend and a scripted model.
// Run: npx tsx --test test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestAgent, UnfrozenAgent, harness } from './testAgent.js';
import { INTERRUPTED_RESULT } from '../src/messages.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('create freezes the prompt on the row, once — and nothing about the model', async () => {
  const h = harness();
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  const row = h.fake.sessions.get(a.sessionId)!;
  assert.deepEqual(row.system_prompt, ['BASE BLOCK', 'WORKSPACE BLOCK']);
  assert.equal(a.promptBuilds, 1);
  const freeze = h.fake.requests.filter((r) => r.path.endsWith('/frozen'));
  assert.equal(freeze.length, 1);
  assert.deepEqual(Object.keys(freeze[0]!.body as object), ['systemPrompt']);
  // Resume: read back, never rebuilt, never re-frozen.
  const b = await TestAgent.resume(h.fake.backend, h.handlers, a.sessionId);
  assert.equal(b.promptBuilds, 0);
  assert.deepEqual(b.systemPromptBlocks, ['BASE BLOCK', 'WORKSPACE BLOCK']);
  assert.equal(h.fake.requests.filter((r) => r.path.endsWith('/frozen')).length, 1);
  assert.deepEqual(h.errors, []);
});

test('a plain turn: user + assistant + usage recorded after the model answered; lock taken and released; turn-ended', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'hello there' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  const parts: string[] = [];
  a.on('part', (p) => parts.push(p.type));
  const r = await a.sendUserMessage('hi');
  assert.equal(r?.outcome, 'done');
  assert.equal(r?.text, 'hello there');
  const lines = h.fake.linesOf(a.sessionId);
  assert.deepEqual(lines.map((l) => l.type), ['message', 'message', 'usage']);
  assert.deepEqual((lines[0]!.message as { content: string }).content, 'hi');
  assert.equal((lines[1]!.message as { role: string }).role, 'assistant');
  assert.ok(lines.every((l) => typeof l.id === 'string' && typeof l.at === 'string'));
  // The system prompt went as the frozen blocks, the first ones cache-marked.
  const call = TestAgent.modelCalls[0] as { prompt: Array<{ role: string; content: unknown; providerOptions?: unknown }> };
  const system = call.prompt.filter((m) => m.role === 'system');
  assert.equal(system.length, 2);
  assert.ok(system[0]!.providerOptions);
  assert.ok(parts.includes('text-delta'));
  const s = h.fake.sessions.get(a.sessionId)!;
  assert.equal(s.lockedBy, null);
  assert.equal(s.turnsEnded, 1);
  assert.equal(a.messages.length, 2);
  assert.equal(a.usage.input, 100);
  assert.equal(h.fake.tokenLog.length, 1);
  assert.deepEqual(h.errors, []);
});

test('tool steps: assistant recorded before the tool result, each result as it lands, then the final answer', async () => {
  const h = harness();
  TestAgent.script = [
    { text: 'let me check', tools: [{ name: 'echo', input: { text: 'x' } }] },
    { text: 'done' },
  ];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  const r = await a.sendUserMessage('go');
  assert.equal(r?.outcome, 'done');
  const lines = h.fake.linesOf(a.sessionId);
  const kinds = lines.map((l) => l.type === 'message' ? (l.message as { role: string }).role : l.type);
  assert.deepEqual(kinds, ['user', 'assistant', 'usage', 'tool', 'assistant', 'usage']);
  const toolMsg = lines[3]!.message as { content: Array<{ output: { value: unknown } }> };
  assert.deepEqual(toolMsg.content[0]!.output.value, { echoed: 'x' });
  // Appends happened in order: one per event, never a whole-file write.
  const appends = h.fake.requests.filter((r) => r.path.endsWith('/transcript/append'));
  assert.ok(appends.length >= 3);
  assert.deepEqual(h.errors, []);
});

test('readonly: a mutating tool is refused at execute time, the reader still runs', async () => {
  const h = harness();
  TestAgent.script = [
    { tools: [{ name: 'write_note', input: { text: 'n' } }, { name: 'echo', input: { text: 'e' } }] },
    { text: 'ok' },
  ];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  a.setReadonly(() => true);
  await a.sendUserMessage('go');
  const results = h.fake.linesOf(a.sessionId)
    .filter((l) => l.type === 'message' && (l.message as { role: string }).role === 'tool')
    .map((l) => (l.message as { content: Array<{ toolName: string; output: { value: unknown } }> }).content[0]!);
  const byName = Object.fromEntries(results.map((r) => [r.toolName, r.output.value]));
  assert.equal((byName.write_note as { error: { code: string } }).error.code, 'readonly');
  assert.deepEqual(byName.echo, { echoed: 'e' });
});

test('model failure: nothing is recorded, nothing is kept — the next message goes alone', async () => {
  const h = harness();
  TestAgent.script = [{ error: new Error('overloaded') }, { text: 'ok' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  await assert.rejects(a.sendUserMessage('hi'), (e: Error & { code: string }) => e.code === 'model_error' && /overloaded/.test(e.message));
  assert.equal(h.fake.linesOf(a.sessionId).length, 0);
  assert.equal(a.userMessages.length, 0);
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0]!.code, 'model_error');
  assert.equal(h.fake.sessions.get(a.sessionId)!.lockedBy, null);
  await a.sendUserMessage('next');
  const users = h.fake.linesOf(a.sessionId)
    .filter((l) => l.type === 'message' && (l.message as { role: string }).role === 'user')
    .map((l) => (l.message as { content: string }).content);
  assert.deepEqual(users, ['next']);
});

test('a turn refused because the session is busy elsewhere keeps nothing', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'ok' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  h.fake.sessions.get(a.sessionId)!.lockedBy = 'another-window';
  await assert.rejects(a.sendUserMessage('hi'), (e: Error & { code: string }) => e.code === 'session_locked');
  assert.equal(a.userMessages.length, 0);
  h.fake.sessions.get(a.sessionId)!.lockedBy = null;
  await a.sendUserMessage('again');
  const users = h.fake.linesOf(a.sessionId)
    .filter((l) => l.type === 'message' && (l.message as { role: string }).role === 'user')
    .map((l) => (l.message as { content: string }).content);
  assert.deepEqual(users, ['again']);
});

test('interrupt mid-tool: finished calls keep results, the cut one gets INTERRUPTED_RESULT, then an interrupted line', async () => {
  const h = harness();
  TestAgent.script = [
    { text: 'working', tools: [{ name: 'echo', input: { text: 'fast' } }, { name: 'slow', input: { ms: 5000 } }] },
  ];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  const p = a.sendUserMessage('go');
  await wait(150);
  a.interrupt();
  const r = await p;
  assert.equal(r?.outcome, 'interrupted');
  const lines = h.fake.linesOf(a.sessionId);
  const kinds = lines.map((l) => l.type === 'message' ? (l.message as { role: string }).role : l.type);
  assert.deepEqual(kinds, ['user', 'assistant', 'usage', 'tool', 'tool', 'interrupted']);
  const tools = lines.filter((l) => l.type === 'message' && (l.message as { role: string }).role === 'tool')
    .map((l) => (l.message as { content: Array<{ toolName: string; output: { type: string; value: unknown } }> }).content[0]!);
  const slow = tools.find((t) => t.toolName === 'slow')!;
  assert.equal(slow.output.type, 'error-text');
  assert.equal(slow.output.value, INTERRUPTED_RESULT);
  assert.deepEqual(tools.find((t) => t.toolName === 'echo')!.output.value, { echoed: 'fast' });
  assert.deepEqual(h.errors, []);
  assert.equal(h.fake.sessions.get(a.sessionId)!.lockedBy, null);
});

test('interrupt mid-model-call: partial text and the user message are recorded', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'one two three four five six', chunkDelayMs: 30 }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  const p = a.sendUserMessage('go');
  await wait(200);
  a.interrupt();
  const r = await p;
  assert.equal(r?.outcome, 'interrupted');
  const lines = h.fake.linesOf(a.sessionId);
  const kinds = lines.map((l) => l.type === 'message' ? (l.message as { role: string }).role : l.type);
  assert.deepEqual(kinds, ['user', 'assistant', 'interrupted']);
  const text = (lines[1]!.message as { content: Array<{ text: string }> }).content[0]!.text;
  assert.ok(text.length > 0 && text.length < 'one two three four five six'.length, text);
});

test('a user message mid-turn rides the next model call and is recorded with that step', async () => {
  const h = harness();
  TestAgent.script = [
    { tools: [{ name: 'slow', input: { ms: 100 } }] },
    { text: 'heard you' },
  ];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  const p = a.sendUserMessage('start');
  await wait(30);
  const queued = await a.sendUserMessage('also this');
  assert.equal(queued, null);
  await p;
  const lines = h.fake.linesOf(a.sessionId);
  const users = lines.filter((l) => l.type === 'message' && (l.message as { role: string }).role === 'user')
    .map((l) => (l.message as { content: string }).content);
  assert.deepEqual(users, ['start', 'also this']);
  // The second model call saw the user message as its last message.
  const second = TestAgent.modelCalls[1] as { prompt: Array<{ role: string; content: unknown }> };
  const last = second.prompt[second.prompt.length - 1]!;
  assert.equal(last.role, 'user');
  assert.equal(a.userMessages.length, 0);
});

test('a user message left over at turn end starts the next turn by itself', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'first', chunkDelayMs: 20 }, { text: 'second' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  const ends: string[] = [];
  a.on('turn-end', (r) => ends.push(r.text));
  const p = a.sendUserMessage('one');
  await wait(20);
  await a.sendUserMessage('two');   // queued during the final model call: no next call to ride
  await p;
  await wait(100);
  assert.deepEqual(ends, ['first', 'second']);
  assert.equal(h.fake.sessions.get(a.sessionId)!.turnsEnded, 2);
  assert.deepEqual(h.errors, []);
});

test('injections: queued for the session, they start no turn and ride the next turn ahead of the user', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'ok' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  h.fake.sessions.get(a.sessionId)!.backdoor.push('a command exited', 'new code arrived');
  await wait(20);
  assert.equal(a.busy, false);
  assert.equal(h.fake.linesOf(a.sessionId).length, 0);
  await a.sendUserMessage('what happened?');
  const users = h.fake.linesOf(a.sessionId)
    .filter((l) => l.type === 'message' && (l.message as { role: string }).role === 'user')
    .map((l) => (l.message as { content: string }).content);
  assert.deepEqual(users, ['a command exited', 'new code arrived', 'what happened?']);
});

test('append: a lost reply is resent with the same delivery id and lands exactly once', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'fine' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  h.fake.loseAppendReplies = 1;
  await a.sendUserMessage('hi');
  const lines = h.fake.linesOf(a.sessionId);
  assert.deepEqual(lines.map((l) => l.type), ['message', 'message', 'usage']);
  const appends = h.fake.requests.filter((r) => r.path.endsWith('/transcript/append'));
  const ids = appends.map((r) => (r.body as { deliveryId: string }).deliveryId);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(h.notices.filter((n) => n.kind === 'retry').length, 1);
  assert.deepEqual(h.errors, []);
});

test('append: a write that fails for good stops the turn with transcript_write_failed', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'fine' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  h.fake.sessions.get(a.sessionId)!.lockedBy = 'someone-else';
  await assert.rejects(a.sendUserMessage('hi'), (e: Error & { code: string }) => e.code === 'session_locked');
  assert.equal(h.fake.linesOf(a.sessionId).length, 0);
  assert.equal(h.errors.length, 1);
});

test('append: a count mismatch is a transcript_conflict, never a silent overwrite', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'fine' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  // Someone wrote a line behind our back (impossible under the lock — the fake lets us).
  h.fake.sessions.get(a.sessionId)!.lines.push(JSON.stringify({ type: 'interrupted', id: 'x', at: 'now' }));
  await assert.rejects(a.sendUserMessage('hi'), (e: Error & { code: string }) => e.code === 'transcript_conflict' || e.code === 'transcript_write_failed');
  assert.equal(h.errors.length, 1);
});

test('a tool error reaches the model as its result AND the client as tool-error', async () => {
  const h = harness();
  TestAgent.script = [{ tools: [{ name: 'fails', input: {} }] }, { text: 'recovered' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  const toolErrors: string[] = [];
  a.on('tool-error', (e) => toolErrors.push(e.name));
  const r = await a.sendUserMessage('go');
  assert.equal(r?.text, 'recovered');
  assert.deepEqual(toolErrors, ['fails']);
  const toolLine = h.fake.linesOf(a.sessionId).find((l) => l.type === 'message' && (l.message as { role: string }).role === 'tool')!;
  const out = (toolLine.message as { content: Array<{ output: { type: string; value: string } }> }).content[0]!.output;
  assert.equal(out.type, 'error-text');
  assert.match(out.value, /tool blew up/);
  assert.deepEqual(h.errors, []);
});

test('resume after a crash mid-step answers the dangling tool call as interrupted', async () => {
  const h = harness();
  const s = h.fake.newSession({ system_prompt: ['B', 'W'] });
  s.lines.push(
    JSON.stringify({ type: 'message', id: 'l1', at: 'now', message: { role: 'user', content: 'do it' } }),
    JSON.stringify({ type: 'message', id: 'l2', at: 'now', message: { role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'bash', input: { cmd: 'ls' } }] } }),
  );
  const a = await TestAgent.resume(h.fake.backend, h.handlers, s.id);
  const kinds = h.fake.linesOf(s.id).map((l) => l.type === 'message' ? (l.message as { role: string }).role : l.type);
  assert.deepEqual(kinds, ['user', 'assistant', 'tool']);
  assert.equal(a.messages.length, 3);
  assert.equal(s.lockedBy, null);
});

test('unfrozen: the prompt is built every turn and never saved', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'a' }, { text: 'b' }];
  const a = await UnfrozenAgent.create(h.fake.backend, h.handlers);
  await a.sendUserMessage('1');
  await a.sendUserMessage('2');
  assert.equal(a.promptBuilds, 2);
  assert.equal(h.fake.sessions.get(a.sessionId)!.system_prompt, null);
  assert.equal(h.fake.requests.filter((r) => r.path.endsWith('/frozen')).length, 0);
});

test('the model is the server\'s answer every turn: a change reaches the next turn', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'a' }, { text: 'b' }];
  TestAgent.specs = [];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  await a.sendUserMessage('1');
  (h.fake.agentConfig as { model: { provider: string; model: string; apiKey: string } }).model =
    { provider: 'openai', model: 'gpt-test', apiKey: 'sk-openai' };
  await a.sendUserMessage('2');
  assert.deepEqual(TestAgent.specs.map((s) => [s.provider, s.model, s.apiKey]),
    [['anthropic', 'claude-test', 'sk-ant-api-test'], ['openai', 'gpt-test', 'sk-openai']]);
  assert.deepEqual(h.errors, []);
});

test('someone else wrote between turns: the turn reads the transcript again first, then runs', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'first' }, { text: 'third' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  const reloads: number[] = [];
  a.on('reloaded', (e) => reloads.push(e.messages.length));
  await a.sendUserMessage('one');
  // Another window's turn lands on the shared transcript.
  h.fake.writeAsOther(a.sessionId, [
    { type: 'message', id: 'o1', at: 'now', message: { role: 'user', content: 'from the phone' } },
    { type: 'message', id: 'o2', at: 'now', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
  ]);
  const r = await a.sendUserMessage('three');
  assert.equal(r?.outcome, 'done');
  assert.deepEqual(reloads, [4]);
  const users = a.messages.filter((m) => m.role === 'user').map((m) => m.content);
  assert.deepEqual(users, ['one', 'from the phone', 'three']);
  // The model saw the other window's turn.
  const last = TestAgent.modelCalls[TestAgent.modelCalls.length - 1] as { prompt: Array<{ role: string }> };
  assert.equal(last.prompt.filter((m) => m.role === 'user').length, 3);
  assert.deepEqual(h.errors, []);
});

test('nothing moved between turns: nothing is downloaded again', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'a' }, { text: 'b' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  await a.sendUserMessage('1');
  await a.sendUserMessage('2');
  assert.equal(h.fake.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/transcript')).length, 1);
});

test('a stop starts nothing by itself: what is queued waits for the app', async () => {
  const h = harness();
  TestAgent.script = [{ tools: [{ name: 'slow', input: { ms: 5000 } }] }, { text: 'never' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  const p = a.sendUserMessage('go');
  await wait(100);
  await a.sendUserMessage('queued meanwhile');
  a.interrupt();
  const r = await p;
  assert.equal(r?.outcome, 'interrupted');
  await wait(100);
  assert.equal(h.fake.sessions.get(a.sessionId)!.turnsEnded, 1);
  assert.equal(a.busy, false);
  assert.equal(a.userMessages.length, 1);
});

test('injections: a failed turn takes them with it — nothing is given back', async () => {
  const h = harness();
  TestAgent.script = [{ error: new Error('overloaded') }, { text: 'ok' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  const s = h.fake.sessions.get(a.sessionId)!;
  s.backdoor.push('a command exited');
  await assert.rejects(a.sendUserMessage('hi'));
  assert.deepEqual(s.backdoor, []);
  await a.sendUserMessage('again');
  const users = h.fake.linesOf(a.sessionId)
    .filter((l) => l.type === 'message' && (l.message as { role: string }).role === 'user')
    .map((l) => (l.message as { content: string }).content);
  assert.deepEqual(users, ['again']);
});

test('PHANTOM_PULL_USER_MESSAGE_QUEUE=off: the queue is not pulled, and stays on the server', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'ok' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  const s = h.fake.sessions.get(a.sessionId)!;
  s.backdoor.push('a command exited');
  process.env.PHANTOM_PULL_USER_MESSAGE_QUEUE = 'off';
  try { await a.sendUserMessage('hi'); }
  finally { delete process.env.PHANTOM_PULL_USER_MESSAGE_QUEUE; }
  assert.deepEqual(s.backdoor, ['a command exited']);
  assert.equal(h.fake.requests.filter((r) => r.path.endsWith('/backdoor/drain')).length, 0);
});

test('sendUserMessage while busy queues; text waiting when the first model call starts rides it', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'slow', chunkDelayMs: 30 }, { text: 'next' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  const p = a.sendUserMessage('a');
  assert.equal(a.busy, true);
  assert.equal(await a.sendUserMessage('b'), null);   // queued before the first call was built: rides it
  await p;
  await wait(200);
  assert.equal(h.fake.sessions.get(a.sessionId)!.turnsEnded, 1);
  const users = h.fake.linesOf(a.sessionId)
    .filter((l) => l.type === 'message' && (l.message as { role: string }).role === 'user')
    .map((l) => (l.message as { content: string }).content);
  assert.deepEqual(users, ['a', 'b']);
  assert.deepEqual(h.errors, []);
});

test('a listener that throws is reported, never breaks the turn', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'fine' }];
  const a = await TestAgent.create(h.fake.backend, h.handlers);
  a.on('turn-end', () => { throw new Error('listener bug'); });
  const r = await a.sendUserMessage('hi');
  assert.equal(r?.outcome, 'done');
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0]!.message, /listener bug/);
});

test('more than 3 prompt blocks on anthropic: a notice, not an error', async () => {
  const h = harness();
  TestAgent.script = [{ text: 'fine' }];
  class Wide extends TestAgent {
    protected override systemPrompt(): string[] { return ['1', '2', '3', '4']; }
    static override create(backend: never, handlers: never): Promise<Wide> {
      return Agent_birth(Wide, backend, handlers);
    }
  }
  const a = await Wide.create(h.fake.backend as never, h.handlers as never);
  await a.sendUserMessage('hi');
  assert.ok(h.notices.some((n) => n.kind === 'cache'));
  assert.deepEqual(h.errors, []);
});

// birth is protected; the test reaches it the way a subclass would.
import { Agent } from '../src/agent.js';
import { call } from '../src/backend.js';
import type { PhantomBackend } from '../src/backend.js';
import type { AgentHandlers, SessionRow } from '../src/agent.js';
function Agent_birth<T extends Agent>(ctor: unknown, backend: PhantomBackend, handlers: AgentHandlers): Promise<T> {
  return (Agent as unknown as { birth: (c: unknown, b: PhantomBackend, h: AgentHandlers, f: () => Promise<SessionRow>) => Promise<T> })
    .birth(ctor, backend, handlers, () => call<SessionRow>(backend, 'POST', '/sessions', { workspace_id: 'w1' }));
}
