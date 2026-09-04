// Headless smoke test for the TUI: reducer, shimmer, batching, and a full
// turn rendered through ink-testing-library against a scripted fake agent.
//   npm run test:tui
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { applyPart, applyTokens, takeCompleted, splitBlocks, phaseLabel, finalize, formatElapsed, formatTokens, messagesToParts, tokenCount, NO_TOKENS, type Part, type StreamPart } from './state.js';
import { Transcript, loadTranscript, dropDanglingToolCall, transcriptPath } from './session.js';
import { Shimmer } from './components/Shimmer.js';
import { PartView } from './components/Parts.js';
import { App } from './App.js';
import { inertVoice } from "./voice.js";
import type { Tool } from 'ai';
import { runTurn, withCacheBreakpoints, INTERRUPTED_RESULT } from './agent.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
/** The pane's top row. Whatever fills the left pane — a session header, a
 *  boot failure — the first thing there is never flush against the edge. */
const topRow = (frame: string) => strip(frame).split('\n')[0];


// App builds its own agent from the config chain; tests hand it a scripted one.
const noApi = async () => ({});
const noTools = async () => ({} as Record<string, Tool>);
const seam = (steps: number) => () => ({
  agent: fakeAgent(steps) as never,
  summary: { provider: 'test', model: 'fake', reasoning: 'none', maxSteps: 40 },
});
/** A transcript pointed at a temp file, so App's own writes go nowhere real. */
const throwaway = () => new Transcript({ ...HEADER },
  join(mkdtempSync(join(tmpdir(), 'phantom-tui-')), 'x.jsonl'));

const INITIAL = {
  sessionId: 's1', branch: 'agent/s1', workspaceId: 'w1',
  tools: {} as Record<string, Tool>, resumed: [] as ModelMessage[],
};

const SCRIPT: StreamPart[] = [
  { type: 'start' } as never,
  { type: 'reasoning-start', id: 'r1' } as never,
  { type: 'reasoning-delta', id: 'r1', text: 'Let me look at the repo.' } as never,
  { type: 'reasoning-end', id: 'r1' } as never,
  { type: 'tool-input-start', id: 't1', toolName: 'read' } as never,
  { type: 'tool-input-delta', id: 't1', delta: '{"path":"README.md"}' } as never,
  { type: 'tool-call', toolCallId: 't1', toolName: 'read', input: { path: 'README.md' } } as never,
  { type: 'tool-result', toolCallId: 't1', toolName: 'read', input: { path: 'README.md' }, output: { ok: true, data: { content: 'a\nb\nc' } } } as never,
  { type: 'tool-call', toolCallId: 't2', toolName: 'bash', input: { cmd: 'false' } } as never,
  { type: 'tool-result', toolCallId: 't2', toolName: 'bash', input: { cmd: 'false' }, output: { ok: false, error: { code: 'exit', message: 'exit 1' } } } as never,
  { type: 'text-start', id: 'x1' } as never,
  { type: 'text-delta', id: 'x1', text: 'Hello **world**' } as never,
  { type: 'text-delta', id: 'x1', text: ' from the agent.' } as never,
  { type: 'text-end', id: 'x1' } as never,
  { type: 'finish-step', usage: { outputTokens: 42 } } as never,
  { type: 'finish', finishReason: 'stop', totalUsage: { outputTokens: 42 } } as never,
];

// What the model actually produced this turn — what onStepEnd hands back and
// what the transcript stores. Mirrors SCRIPT.
const STEP_MESSAGES: ModelMessage[] = [
  { role: 'assistant', content: [
    { type: 'tool-call', toolCallId: 't1', toolName: 'read', input: { path: 'README.md' } },
  ] },
  { role: 'tool', content: [
    { type: 'tool-result', toolCallId: 't1', toolName: 'read',
      output: { type: 'json', value: { ok: true, data: { content: 'a\nb\nc' } } } },
  ] },
  { role: 'assistant', content: [{ type: 'text', text: 'Hello world from the agent.' }] },
];

// Mirrors createAgent's RecordingAgent contract: `record` (when passed) gets
// each step — messages + usage — exactly as the real agent writes it.
const fakeAgent = (delayMs: number) => ({
  stream: async ({ onStepEnd, record }: { onStepEnd?: (s: unknown) => void;
    record?: { appendStep: (m: ModelMessage[], u?: { outputTokens?: number }) => void } }) => ({
    stream: (async function* () {
      for (const p of SCRIPT) { yield p; await sleep(delayMs); }
      record?.appendStep(STEP_MESSAGES, { outputTokens: 42 });
      onStepEnd?.({ response: { messages: STEP_MESSAGES } });
    })(),
    responseMessages: Promise.resolve([{ role: 'assistant', content: 'Hello world from the agent.' }]),
  }),
}) as never;

test('reducer folds parts and promotes finished prefix', () => {
  let turn: ReturnType<typeof applyPart> = [];
  for (const p of SCRIPT.slice(0, 6)) turn = applyPart(turn, p);
  assert.equal(turn.length, 2);
  assert.equal(turn[0].kind, 'reasoning'); assert.equal((turn[0] as { done: boolean }).done, true);
  assert.equal(turn[1].kind, 'tool'); assert.equal((turn[1] as { status: string }).status, 'pending');
  assert.equal(phaseLabel(turn), 'read');
  let split = takeCompleted(turn);
  assert.equal(split.done.length, 1); assert.equal(split.live.length, 1);
  for (const p of SCRIPT.slice(6)) turn = applyPart(turn, p);
  const t = turn.find((p) => p.kind === 'tool' && p.id === 't2') as { status: string; error: string };
  assert.equal(t.status, 'error'); assert.match(t.error, /exit 1/);
  split = takeCompleted(turn);
  assert.equal(split.live.length, 0);
  assert.equal(finalize([{ kind: 'text', id: 'z', text: '', done: false }]).length, 0);
});

test('reducer: a block id reused across steps starts a new part, never reopens a finished one', () => {
  // Anthropic block ids are the content-block index of one API call, so every
  // step's first text block arrives as id "0". Matched naively, step 2's text
  // concatenated onto step 1's finished part and the tool rows rendered after
  // the whole answer.
  let turn: Part[] = [];
  const parts: StreamPart[] = [
    { type: 'text-start', id: '0' } as never,
    { type: 'text-delta', id: '0', text: 'Let me look.' } as never,
    { type: 'text-end', id: '0' } as never,
    { type: 'tool-call', toolCallId: 'call1', toolName: 'find', input: { pattern: '*' } } as never,
    { type: 'tool-result', toolCallId: 'call1', toolName: 'find', input: { pattern: '*' }, output: { ok: true, data: { matches: [] } } } as never,
    { type: 'text-start', id: '0' } as never,
    { type: 'text-delta', id: '0', text: 'Nothing there.' } as never,
    { type: 'text-end', id: '0' } as never,
  ];
  for (const p of parts) turn = applyPart(turn, p);
  assert.deepEqual(turn.map((p) => p.kind), ['text', 'tool', 'text'], 'the second step\'s text lands after the tools');
  assert.equal((turn[0] as { text: string }).text, 'Let me look.');
  assert.equal((turn[2] as { text: string }).text, 'Nothing there.');
});

test('token count: estimate between steps, the real number at each step end', () => {
  let t = NO_TOKENS;
  t = applyTokens(t, { type: 'text-delta', id: 'x', text: 'a'.repeat(40) } as never);
  assert.equal(tokenCount(t), 10, '40 chars ≈ 10 tokens while nothing is reported');
  t = applyTokens(t, { type: 'reasoning-delta', id: 'r', text: 'b'.repeat(10) } as never);
  t = applyTokens(t, { type: 'tool-input-delta', id: 't', delta: 'c'.repeat(10) } as never);
  assert.equal(tokenCount(t), 15, 'reasoning and tool input count too');
  t = applyTokens(t, { type: 'finish-step', usage: { outputTokens: 123 } } as never);
  assert.equal(tokenCount(t), 123, 'the provider\'s number replaces the estimate');
  t = applyTokens(t, { type: 'text-delta', id: 'y', text: 'd'.repeat(8) } as never);
  assert.equal(tokenCount(t), 125, 'and the estimate resumes on top of it');
  t = applyTokens(t, { type: 'finish-step', usage: {} } as never);
  assert.equal(tokenCount(t), 125, 'a step without usage keeps the estimate');
  t = applyTokens(t, { type: 'finish', totalUsage: { outputTokens: 130 } } as never);
  assert.equal(tokenCount(t), 130, 'the turn total wins at the end');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(1700), '1.7k');
  assert.equal(formatTokens(12400), '12k');
  assert.equal(formatElapsed(44_000), '44s');
  assert.equal(formatElapsed(124_000), '2m 4s');
});

test('splitBlocks closes paragraphs and fences, keeps the open block', () => {
  assert.deepEqual(splitBlocks('no newline yet'), { closed: [], open: 'no newline yet' });
  // A newline alone does not close a paragraph — only a blank line does.
  assert.deepEqual(splitBlocks('one\ntwo\n'), { closed: [], open: 'one\ntwo\n' });
  assert.deepEqual(splitBlocks('one\n\ntwo'), { closed: ['one'], open: 'two' });
  // An unterminated fence stays open even across blank lines.
  assert.deepEqual(splitBlocks('```js\nconst a = 1;\n\n'), { closed: [], open: '```js\nconst a = 1;\n\n' });
  assert.deepEqual(splitBlocks('```js\nconst a = 1;\n```\nafter'), {
    closed: ['```js\nconst a = 1;\n```'], open: 'after',
  });
});

test('splitBlocks keeps a list with blank lines between items as one block', () => {
  // One item per block rendered alone and numbered 1. again — the 1. 1. 1. list.
  const list = '1. one\n\n2. two\n\n3. three';
  assert.deepEqual(splitBlocks(list + '\n\nAfter.\n\n'), { closed: [list, 'After.'], open: '' });
  // A blank inside a list is not decided until the next line arrives.
  assert.deepEqual(splitBlocks('- a\n\n'), { closed: [], open: '- a\n\n' });
  // An indented continuation keeps the list open; a plain paragraph closes it.
  assert.deepEqual(splitBlocks('- a\n\n  more of a\n\nPara\n'), { closed: ['- a\n\n  more of a'], open: 'Para\n' });
});

test('streaming commits blocks as they close and never duplicates text', () => {
  const message = [
    'First para line one.\nstill first.',
    'Second para.',
    '```js\nconst a = 1;\n```',
    'Tail being typed',
  ].join('\n\n');

  let turn: Part[] = applyPart([], { type: 'text-start', id: 'x' } as never);
  const committed: string[] = [];
  let maxLive = 0;

  for (const chunk of message.match(/[\s\S]{1,7}/g)!) {
    turn = applyPart(turn, { type: 'text-delta', id: 'x', text: chunk } as never);
    const split = takeCompleted(turn);
    turn = split.live;
    for (const p of split.done) if (p.kind === 'text') committed.push(p.text);
    const open = turn.find((p) => p.kind === 'text') as { text: string } | undefined;
    maxLive = Math.max(maxLive, open?.text.length ?? 0);
  }

  turn = applyPart(turn, { type: 'text-end', id: 'x' } as never);
  for (const p of finalize(turn)) if (p.kind === 'text') committed.push(p.text);

  assert.equal(committed.join('\n\n'), message, 'every byte committed exactly once, in order');
  assert.equal(committed.length, 4, 'one part per closed block');
  assert.ok(maxLive < message.length, `live block stayed partial (peaked at ${maxLive}/${message.length})`);
});

// A bash call used to cost whatever the command and its output happened to
// be — a 20-line heredoc took 21 rows of the screen and ignored the live
// region's budget entirely. Now the block is bounded in rows, and ctrl+o
// (`expanded`) is the way to the rest.
test('a tool row is bounded in rows, and ctrl+o lifts the bound', () => {
  const heredoc = `python3 - <<'PY'\n${Array.from({ length: 18 }, (_, i) => `  print(${i})`).join('\n')}\nPY`;
  const part: Part = {
    kind: 'tool', id: 't', name: 'bash', inputText: '', input: { cmd: heredoc }, status: 'ok',
    startedAt: 0, endedAt: 1,
    output: { ok: true, data: { exitCode: 1, stdout: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'), stderr: 'BOOM' } },
  };
  const rows = (expanded: boolean) => {
    const r = render(<PartView part={part} width={100} expanded={expanded} maxRows={8} />);
    try { return strip(r.lastFrame()!).split('\n'); } finally { r.unmount(); }
  };
  const clipped = rows(false);
  assert.ok(clipped.length <= 9, `bash cost ${clipped.length} rows: ${clipped.join('|')}`);
  assert.match(clipped.join('\n'), /… \+17 lines \(ctrl\+o\)/, 'the command says how much it hid');
  assert.match(clipped.join('\n'), /BOOM/, 'the END of the output survives — that is where failures are');
  assert.ok(!clipped.join('\n').includes('line 0\n'), 'the head of a long output is what gets dropped');
  const full = rows(true).join('\n');
  assert.match(full, /print\(17\)/, 'ctrl+o shows the whole command');
  assert.match(full, /line 0\n/, 'and the whole output');
});

test('shimmer animates', async () => {
  const r = render(<Shimmer text="Thinking" intervalMs={20} />);
  try {
    const f1 = r.lastFrame()!;
    assert.equal(strip(f1), 'Thinking');
    await sleep(120);
    const f2 = r.lastFrame()!;
    assert.equal(strip(f2), 'Thinking');
    assert.notEqual(f1, f2, 'ANSI highlight should have moved');
  } finally { r.unmount(); }
});

test('runTurn batches deltas and preserves order', async () => {
  const batches: StreamPart[][] = [];
  const reply = await runTurn(fakeAgent(5), [], (b) => batches.push(b), new AbortController().signal);
  assert.equal(reply.length, 1);
  assert.deepEqual(batches.flat().map((p) => p.type), SCRIPT.map((p) => p.type));
  assert.ok(batches.length < SCRIPT.length, 'deltas should be batched');
});

// A stream that ends the way the SDK ends an interrupted one: the parts so
// far, then `abort`, then closed — no finish-step, no onStepEnd.
const cutAgent = (parts: StreamPart[]) => ({
  stream: async () => ({
    stream: (async function* () {
      for (const p of parts) yield p;
      yield { type: 'abort' } as never;
    })(),
    responseMessages: new Promise<never>(() => {}),   // never settles — an interrupt must not wait on it
  }),
}) as never;

test('runTurn records the step esc cut: every call, the results that arrived, and a stand-in for the one that did not', async () => {
  const steps: ModelMessage[][] = [];
  const recorded: ModelMessage[][] = [];
  const events: string[] = [];
  const record = { appendStep: (m: ModelMessage[]) => recorded.push(m), appendEvent: (e: { type: string }) => events.push(e.type) };
  const parts: StreamPart[] = [
    { type: 'start' } as never,
    { type: 'text-start', id: 'x' } as never,
    { type: 'text-delta', id: 'x', text: 'Restoring' } as never,
    { type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: { cmd: 'git stash pop' } } as never,
    { type: 'tool-result', toolCallId: 't1', toolName: 'bash', input: { cmd: 'git stash pop' }, output: { ok: true, data: { exitCode: 0 } } } as never,
    { type: 'tool-call', toolCallId: 't2', toolName: 'bash', input: { cmd: 'npm test' } } as never,
  ];
  const ac = new AbortController(); ac.abort();
  const reply = await runTurn(cutAgent(parts), [], () => {}, ac.signal, (m) => steps.push(m), 0, record);
  const expected: ModelMessage[] = [
    { role: 'assistant', content: [
      { type: 'text', text: 'Restoring' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: { cmd: 'git stash pop' } },
      { type: 'tool-call', toolCallId: 't2', toolName: 'bash', input: { cmd: 'npm test' } },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 't1', toolName: 'bash', output: { type: 'json', value: { ok: true, data: { exitCode: 0 } } } },
      { type: 'tool-result', toolCallId: 't2', toolName: 'bash', output: { type: 'error-text', value: INTERRUPTED_RESULT } },
    ] },
  ];
  assert.deepEqual(steps, [expected], 'history gets the cut step — the pop RAN');
  assert.deepEqual(recorded, [expected], 'and so does the transcript');
  assert.deepEqual(events, ['interrupted'], 'marked, so a reader sees where esc landed');
  assert.deepEqual(reply, expected);
  assert.match(INTERRUPTED_RESULT, /may already have finished/, 'the stand-in says no result ≠ did not run');
});

test('runTurn does not write a step the SDK already closed, and writes nothing when nothing streamed', async () => {
  const steps: ModelMessage[][] = [];
  const record = { appendStep: (m: ModelMessage[]) => steps.push(m), appendEvent: () => steps.push([]) };
  const closed: StreamPart[] = [
    { type: 'tool-call', toolCallId: 't1', toolName: 'read', input: { path: 'a' } } as never,
    { type: 'tool-result', toolCallId: 't1', toolName: 'read', input: { path: 'a' }, output: 'x' } as never,
    { type: 'finish-step', usage: {} } as never,          // the SDK records this one through onStepEnd
  ];
  const ac = new AbortController(); ac.abort();
  assert.deepEqual(await runTurn(cutAgent(closed), [], () => {}, ac.signal, (m) => steps.push(m), 0, record), []);
  assert.deepEqual(await runTurn(cutAgent([{ type: 'start' } as never]), [], () => {}, ac.signal, (m) => steps.push(m), 0, record), []);
  assert.deepEqual(steps, [], 'no double record, no empty record');
});

test('App renders a full turn', async () => {
  const r = render(<App api={noApi} initial={INITIAL} newTools={noTools} makeVoice={inertVoice} makeAgent={seam(10)}
    makeTranscript={throwaway} loadHistory={() => []} />);
  try {
    await sleep(50);
    assert.match(strip(r.lastFrame()!), /test\/fake · reasoning none/, 'the header is readable from the first frame');
    assert.match(strip(r.lastFrame()!), /█████/, 'the launch splash sits in the space under it');
    assert.match(strip(r.lastFrame()!), /type a message/);
    r.stdin.write('do the thing');
    await sleep(30);
    r.stdin.write('\r');
    await sleep(80);
    assert.match(strip(r.frames.join('\n')), /\[esc\] to interrupt/, 'status line while busy');
    await sleep(600);
    const all = strip(r.frames.join('\n'));
    assert.doesNotMatch(strip(r.lastFrame()!), /█████/, 'the splash is gone after the first message');
    assert.match(all, /› do the thing/);
    assert.doesNotMatch(all, /Let me look at the repo\./, 'thinking text takes no room while it streams (ctrl+o shows it)');
    assert.match(all, /Thought for \ds/, 'a finished thought is one dim row');
    assert.match(all, /Working…  \(\ds · ↓ \d+ tokens · (thinking|read|bash|writing)\)/, 'elapsed · tokens · phase in one line');
    assert.match(all, /read README\.md/);
    assert.match(all, /3 lines/);
    assert.match(all, /bash false/);
    assert.match(all, /exit: exit 1/);
    assert.match(all, /Hello world from the agent\./);
    assert.match(strip(r.lastFrame()!), /type a message/, 'prompt back after turn');
    const last = strip(r.lastFrame()!);
    assert.match(last, /━{10,}/, 'typing area is fenced by solid rules');
    // Nothing sits under the typing area unless there is a notice to show.
    assert.ok(!/auto mode/.test(last), 'no mode indicator: modes are not built');
  } finally { r.unmount(); }
});

// --- the empty window: boot lives INSIDE the app -----------------------------
// The window must come up whatever is wrong — the screens that fix a dead
// token or a bad address are all in here — so launch passes `boot` and App
// opens its own first session through the same path /new uses. A failure is
// words in the pane, never a crash before the app exists.

test('boot failure lands in the pane: the app is up, typing is refused with a hint, slash screens still answer', async () => {
  const api = async (method: string, path: string) => {
    if (method === 'GET' && path === '/workspaces') return [{ id: 'w1', name: 'acme-app' }];
    if (method === 'POST' && path.split('?')[0] === '/sessions') {
      const e = new Error('cannot check out acme/acme-app: GitHub rejected the stored github_token — it may have expired or been revoked. Save a new one (phantom-cli: /keys)') as Error & { code?: string };
      e.code = 'credential_invalid';
      throw e;
    }
    return {};
  };
  const r = render(<App api={api as never} boot={{}} newTools={noTools} makeVoice={inertVoice}
    makeAgent={seam(10)} makeTranscript={throwaway} loadHistory={() => []} />);
  try {
    await sleep(80);
    const frame = strip(r.lastFrame()!);
    assert.equal(topRow(r.lastFrame()!).trim(), '', 'a blank row above the first line in the pane');
    assert.match(frame, /could not open: cannot check out acme\/acme-app/, "the server's words, in the pane");
    assert.match(frame, /\/keys/, 'the error names where the fix is');
    assert.match(frame, /no session open — \[\/workspace\] starts one/, 'the toolbar says the state');
    assert.match(frame, /type a message/, 'the prompt is alive — the app opened');

    // A plain message has no conversation to land in; the refusal says where
    // to get one. The words are not silently dropped into nothing.
    r.stdin.write('hello');
    await sleep(30);
    r.stdin.write('\r');
    await sleep(50);
    assert.match(strip(r.lastFrame()!), /no session is open — \/workspace starts one/, 'typing is refused with the hint');

    // The fix-it screens answer with no session: /keys opens.
    r.stdin.write('/keys');
    await sleep(30);
    r.stdin.write('\r');
    await sleep(80);
    assert.match(strip(r.lastFrame()!), /github token/, '/keys is on screen — the fix is reachable from the empty state');
  } finally { r.unmount(); }
});

test('boot with one workspace opens a session through the same path /new uses', async () => {
  let minted = 0;
  const api = async (method: string, path: string) => {
    if (method === 'GET' && path === '/workspaces') return [{ id: 'w1', name: 'acme-app' }];
    if (method === 'POST' && path.split('?')[0] === '/sessions') {
      const id = `s${9 + minted++}`;
      return { id, workspaceId: 'w1', branch: `agent/${id}`, status: 'active', skills: [] };
    }
    if (/^\/sessions\/s\d+\/transcript$/.test(path)) return { data: null };
    if (path === '/workspaces/w1') return { name: 'acme-app' };
    return {};
  };
  const r = render(<App api={api as never} boot={{}} newTools={noTools} makeVoice={inertVoice}
    makeAgent={seam(10)} makeTranscript={throwaway} loadHistory={() => []} />);
  try {
    await sleep(120);
    assert.match(strip(r.lastFrame()!), /acme-app · agent\/s9/, 'the session banner is on screen');
    assert.doesNotMatch(strip(r.lastFrame()!), /no session open/, 'the toolbar hint is gone');
    assert.equal(topRow(r.lastFrame()!).trim(), '', 'a blank row above the header at launch');

    // /new — the second session opens with the same breathing room.
    r.stdin.write('/new');
    await sleep(40);
    r.stdin.write('\r');
    await sleep(200);
    assert.match(strip(r.lastFrame()!), /acme-app · agent\/s10/, 'the new session is on screen');
    assert.equal(topRow(r.lastFrame()!).trim(), '', 'a blank row above the header of a new session');
    assert.match(strip(r.lastFrame()!), /█████/, '/new opens on the splash again');
    r.stdin.write('hello');
    await sleep(30);
    r.stdin.write('\r');
    await sleep(120);
    assert.doesNotMatch(strip(r.lastFrame()!), /█████/, 'the first message clears it');
  } finally { r.unmount(); }
});

test('an unreachable server still opens the window, pointing at the screen that fixes the address', async () => {
  const api = async (method: string, path: string) => {
    if (method === 'GET' && path === '/workspaces') throw new Error('fetch failed');
    return {};
  };
  const r = render(<App api={api as never} boot={{}} newTools={noTools} makeVoice={inertVoice}
    makeAgent={seam(10)} makeTranscript={throwaway} loadHistory={() => []} />);
  try {
    await sleep(80);
    const frame = strip(r.lastFrame()!);
    assert.match(frame, /could not reach the server: fetch failed/);
    assert.match(frame, /\/server/, 'points at the offline screen where the address lives');
    assert.match(frame, /type a message/, 'the app opened anyway');
  } finally { r.unmount(); }
});

// --- transcript --------------------------------------------------------------

test('resume with unsaved steps on this machine: the local file opens and goes up', async () => {
  // A window died mid-turn after the server's last save: the local file is
  // the server's text plus the steps never uploaded. Reopening keeps that
  // file, shows it, and uploads it — the record catches up.
  const server = '{"role":"user","content":"earlier question"}\n{"role":"assistant","content":"earlier answer"}\n';
  const unsaved = '{"role":"user","content":"the lost message"}\n{"role":"assistant","content":"the lost reply"}\n';
  writeFileSync(transcriptPath('sKEPT'), server + unsaved, { mode: 0o600 });
  const puts: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    if (method === 'GET' && path === '/workspaces') return [{ id: 'w1', name: 'acme-app' }];
    if (method === 'GET' && path === '/sessions/sKEPT') return { id: 'sKEPT', workspaceId: 'w1', branch: 'agent/sKEPT', status: 'active', skills: [] };
    if (method === 'GET' && path === '/sessions/sKEPT/transcript') return { data: server, updated_at: 'T1' };
    if (method === 'PUT' && path === '/sessions/sKEPT/transcript') { puts.push(body); return { updated_at: 'T2' }; }
    if (path === '/workspaces/w1') return { name: 'acme-app' };
    return {};
  };
  const r = render(<App api={api as never} boot={{ resumeId: 'sKEPT' }} newTools={noTools} makeVoice={inertVoice}
    makeAgent={seam(10)} makeTranscript={throwaway} loadHistory={() => []} />);
  try {
    await sleep(150);
    const frame = strip(r.lastFrame()!);
    assert.match(frame, /the lost message/, 'the unsaved turn is on screen');
    assert.match(frame, /unsaved steps found on this machine — uploaded/);
    assert.deepEqual(puts, [{ data: server + unsaved }], 'the whole local file went up, once');
    assert.equal(readFileSync(transcriptPath('sKEPT'), 'utf8'), server + unsaved, 'the file is untouched');
  } finally { r.unmount(); }
});

test('resume when the server moved on without this machine: the server copy wins', async () => {
  const server = '{"role":"user","content":"earlier question"}\n{"role":"assistant","content":"earlier answer"}\n{"role":"user","content":"from telegram"}\n';
  const stale = '{"role":"user","content":"earlier question"}\n{"role":"assistant","content":"earlier answer"}\n{"role":"user","content":"a dead window\'s draft"}\n';
  writeFileSync(transcriptPath('sSTALE'), stale, { mode: 0o600 });
  const puts: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    if (method === 'GET' && path === '/workspaces') return [{ id: 'w1', name: 'acme-app' }];
    if (method === 'GET' && path === '/sessions/sSTALE') return { id: 'sSTALE', workspaceId: 'w1', branch: 'agent/sSTALE', status: 'active', skills: [] };
    if (method === 'GET' && path === '/sessions/sSTALE/transcript') return { data: server, updated_at: 'T1' };
    if (method === 'PUT') puts.push(body);
    if (path === '/workspaces/w1') return { name: 'acme-app' };
    return {};
  };
  const r = render(<App api={api as never} boot={{ resumeId: 'sSTALE' }} newTools={noTools} makeVoice={inertVoice}
    makeAgent={seam(10)} makeTranscript={throwaway} loadHistory={() => []} />);
  try {
    await sleep(150);
    const frame = strip(r.lastFrame()!);
    assert.match(frame, /from telegram/);
    assert.doesNotMatch(frame, /dead window/);
    assert.equal(puts.length, 0, 'nothing uploaded');
    assert.equal(readFileSync(transcriptPath('sSTALE'), 'utf8'), server, 'the server copy replaced the file');
  } finally { r.unmount(); }
});


const HEADER = {
  type: 'session', session_id: 's1', workspace: 'r1', branch: 'agent/s1',
  provider: 'anthropic', model: 'claude-opus-5', created_at: '2026-08-21T00:00:00.000Z',
} as const;

test('transcript is created lazily and appended message by message', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'phantom-tui-')), 's1.jsonl');
  const t = new Transcript({ ...HEADER }, file);
  assert.equal(existsSync(file), false, 'no file until something is said');

  t.append({ role: 'user', content: 'hi' });
  t.appendAll(STEP_MESSAGES);
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 1 + 1 + STEP_MESSAGES.length, 'header + user + one line per message');
  assert.deepEqual(JSON.parse(lines[0]), { agent: 'coding', ...HEADER }, 'the header names its agent');

  const loaded = loadTranscript('s1', file);
  assert.equal(loaded.header?.session_id, 's1');
  assert.deepEqual(loaded.messages, [{ role: 'user', content: 'hi' }, ...STEP_MESSAGES]);
});

test('a torn last line costs one line, not the session', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'phantom-tui-')), 's2.jsonl');
  const t = new Transcript({ ...HEADER }, file);
  t.append({ role: 'user', content: 'hi' });
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"role":"assist`);   // killed mid-append
  assert.deepEqual(loadTranscript('s2', file).messages, [{ role: 'user', content: 'hi' }]);
});

test('history is cut at a tool call that never got its result', () => {
  const kept: ModelMessage[] = [{ role: 'user', content: 'hi' }];
  const dangling: ModelMessage[] = [...kept, STEP_MESSAGES[0]];
  assert.deepEqual(dropDanglingToolCall(dangling), kept);
  assert.deepEqual(dropDanglingToolCall([...kept, ...STEP_MESSAGES]), [...kept, ...STEP_MESSAGES]);
});

test('stored messages render as the parts the stream would have produced', () => {
  const parts = messagesToParts([{ role: 'user', content: 'do the thing' }, ...STEP_MESSAGES]);
  assert.deepEqual(parts.map((p) => p.kind), ['user', 'tool', 'text']);
  const tool = parts[1] as Extract<Part, { kind: 'tool' }>;
  assert.equal(tool.name, 'read');
  assert.equal(tool.status, 'ok');
  assert.deepEqual(tool.input, { path: 'README.md' });

  const failed = messagesToParts([
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'x', toolName: 'bash', input: { cmd: 'false' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'x', toolName: 'bash',
      output: { type: 'json', value: { ok: false, error: { code: 'exit', message: 'exit 1' } } } }] },
  ]);
  assert.equal((failed[0] as Extract<Part, { kind: 'tool' }>).status, 'error');
  assert.match((failed[0] as Extract<Part, { kind: 'tool' }>).error!, /exit: exit 1/);

  // A call with no result at all: the process died inside the step.
  const cut = messagesToParts([STEP_MESSAGES[0]]);
  assert.equal((cut[0] as Extract<Part, { kind: 'tool' }>).error, 'interrupted');
});

test('cache breakpoints mark the first and last message only', () => {
  const msgs: ModelMessage[] = [
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' },
  ];
  const marked = withCacheBreakpoints(msgs);
  const cached = (m: ModelMessage) =>
    (m.providerOptions?.anthropic as { cacheControl?: unknown } | undefined)?.cacheControl;
  assert.deepEqual(marked.map((m) => Boolean(cached(m))), [true, false, true]);
  assert.equal(msgs.some((m) => m.providerOptions), false, 'history itself stays clean');
  assert.deepEqual(withCacheBreakpoints([]), []);
});

test('a resumed session repaints its history and keeps writing to the same file', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'phantom-tui-')), 's3.jsonl');
  const transcript = new Transcript({ ...HEADER }, file);
  const resumed: ModelMessage[] = [{ role: 'user', content: 'earlier question' }, ...STEP_MESSAGES];
  const r = render(
    <App api={noApi} initial={{ ...INITIAL, resumed }} newTools={noTools} makeVoice={inertVoice}
      makeAgent={seam(2)} makeTranscript={() => transcript} loadHistory={() => []} />,
  );
  try {
    await sleep(50);
    const first = strip(r.frames.join('\n'));
    assert.doesNotMatch(first, /█████/, 'no splash on resume — history shows at once');
    assert.match(first, /› earlier question/, 'past user message repainted');
    assert.match(first, /read README\.md/, 'past tool row repainted');
    assert.match(first, /Hello world from the agent\./, 'past reply repainted');

    r.stdin.write('next question');
    await sleep(30);
    r.stdin.write('\r');
    // Poll rather than a fixed sleep: under load (the full suite, a busy
    // machine) 400ms was not always enough for the turn to land — the one
    // flaky test in the file.
    for (let i = 0; i < 100 && loadTranscript('s3', file).messages.length < 2; i++) await sleep(50);
    const loaded = loadTranscript('s3', file).messages;
    assert.deepEqual(loaded[0], { role: 'user', content: 'next question' },
      'only the new turn is written — the resumed history was already on disk');
    assert.deepEqual(loaded.slice(1), STEP_MESSAGES, 'step messages land as the step ends');
  } finally { r.unmount(); }
});

test('a reply row\'s id is ours, never the provider\'s — block ids repeat every call', () => {
  // Anthropic numbers a reply's blocks from 0, so every reply's first text
  // block arrives as id '0'. The row id is the React key: reusing the
  // provider's meant two rows named '0' after the second reply — a React
  // duplicate-key warning on every redraw (240 in one live session, and each
  // one, while Ink still patched the console, a full-screen erase + repaint).
  const reply = (turn: Part[]) => {
    for (const p of [
      { type: 'text-start', id: '0' }, { type: 'text-delta', id: '0', text: 'hi' }, { type: 'text-end', id: '0' },
    ] as StreamPart[]) turn = applyPart(turn, p);
    return turn;
  };
  const two = reply(reply([]));
  assert.equal(two.length, 2);
  assert.notEqual(two[0].id, two[1].id, 'each reply row has its own identity');
  assert.equal((two[1] as { text: string }).text, 'hi', 'and the second reply never appends into the first');
});
