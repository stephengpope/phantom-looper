// Several sessions open at once: the store that owns them, and the keys that
// move between them.
//
// The store half runs without React — a turn streaming into a session nobody
// is looking at is exactly the case component state cannot express, so it is
// tested where it lives. The App half drives real keystrokes through
// ink-testing-library, because "tab switches session" is only true if Ink
// actually hands tab to the right handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelMessage, Tool } from 'ai';
import { App } from './App.js';
import { inertVoice } from "./voice.js";
import { SessionStore, type RunTurn } from './sessions.js';
import { Transcript } from './session.js';
import { switcherChoices, lastSaid } from './components/SessionSwitcher.js';
import type { StreamPart } from './state.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const TAB = '\t';
const SHIFT_TAB = '\x1b[Z';
const CTRL_N = '\x0e';
// Sent by the terminals that have a shift+↑ at all — it must NOT open the list:
// Apple Terminal collapses it to a plain ↑, so the key could never be taught.
const SHIFT_UP = '\x1b[1;2A';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ENTER = '\r';
const ESC = '\x1b';

// os.tmpdir(), never a hardcoded path: /private/tmp is macOS's and does not
// exist on Linux, which failed every test in this file on a Linux box.
const tmp = () => join(mkdtempSync(join(tmpdir(), 'phantom-multi-')), 'x.jsonl');
const transcriptFor = (id: string) => new Transcript({
  type: 'session', session_id: id, workspace: 'w1', branch: `agent/${id}`,
  provider: 'test', model: 'fake', created_at: '2026-08-22T00:00:00.000Z',
}, tmp());

const summary = { provider: 'test', model: 'fake', reasoning: 'none', maxSteps: 40 };
const stubAgent = (_tools?: unknown, _cfg?: unknown, _instructions?: string) => ({ agent: { id: 'a' } as never, summary });

/** One session's worth of scaffolding — no model, no network. */
function seed(store: SessionStore, id: string, history: ModelMessage[] = []) {
  return store.add({
    id, branch: `agent/${id}`, workspaceId: 'w1',
    tools: {} as Record<string, Tool>,
    agent: { id } as never, summary, transcript: transcriptFor(id),
    history,
  });
}

/** A turn that says one thing, slowly enough to still be running when asked. */
const say = (text: string, ms = 0): StreamPart[] => ([
  { type: 'text-start', id: `t-${text}` },
  { type: 'text-delta', id: `t-${text}`, text },
  { type: 'text-end', id: `t-${text}` },
] as never[]);

/** A scripted turn runner in place of the model. `hold` keeps it busy. */
function scriptedRun(opts: { text?: string; hold?: number; throws?: string } = {}): RunTurn {
  return (async (_agent, _messages, onParts, signal, onStep, _flushMs, record) => {
    if (opts.hold) {
      const until = Date.now() + opts.hold;
      while (Date.now() < until && !signal.aborted) await sleep(10);
    }
    if (signal.aborted) return [];
    if (opts.throws) throw new Error(opts.throws);
    onParts(say(opts.text ?? 'ok'));
    const messages: ModelMessage[] = [{ role: 'assistant', content: opts.text ?? 'ok' }];
    // The real runTurn records the step (messages + usage line) through
    // createAgent's `record` seam; the script mirrors that contract.
    record?.appendStep(messages, undefined);
    onStep?.(messages);
    return messages;
  }) as RunTurn;
}

// ── the store ───────────────────────────────────────────────────────────────

test('every settled turn fires onTurnEnd — answered or failed — the transcript upload seam', async () => {
  const seen: string[] = [];
  const store = new SessionStore(scriptedRun({ text: 'answer' }), (e) => seen.push(e.id));
  seed(store, 's1');
  await store.send('s1', 'hello');
  assert.deepEqual(seen, ['s1'], 'an answered turn syncs');

  const bad = new SessionStore(scriptedRun({ throws: 'boom' }), (e) => seen.push(`failed:${e.id}`));
  seed(bad, 's2');
  await bad.send('s2', 'hello');
  assert.deepEqual(seen, ['s1', 'failed:s2'], 'a failed turn still syncs — the user message is on disk');

  // A hook that throws must never break the turn loop.
  const hostile = new SessionStore(scriptedRun(), () => { throw new Error('sync exploded'); });
  seed(hostile, 's3');
  await hostile.send('s3', 'hello');
  assert.equal(hostile.get('s3')!.busy, false, 'the turn settled despite the hook');
});

test('a session already open is switched to, never opened twice', () => {
  const store = new SessionStore(scriptedRun());
  seed(store, 's1');
  seed(store, 's2');
  assert.equal(store.list().length, 2);
  // /resume on one that is already loaded.
  seed(store, 's1');
  assert.equal(store.list().length, 2, 'no duplicate entry');
  assert.equal(store.activeId, 's1', 'and it became the active one');
});

test('order is by last message sent — visiting a session does not reorder it', async () => {
  const store = new SessionStore(scriptedRun());
  seed(store, 's1'); seed(store, 's2'); seed(store, 's3');

  await store.send('s1', 'first');
  await sleep(5);
  await store.send('s2', 'second');
  assert.deepEqual(store.list().map((e) => e.id), ['s2', 's1', 's3'],
    'spoken-to first, most recent leading');

  // Tabbing through them must not move them under your fingers.
  store.activate('s3');
  store.activate('s1');
  assert.deepEqual(store.list().map((e) => e.id), ['s2', 's1', 's3'],
    'visiting is not activity');
});

test('the ring walks both ways, and says nothing when there is only one', async () => {
  const store = new SessionStore(scriptedRun());
  seed(store, 'only');
  assert.equal(store.next(1), undefined, 'nowhere to go');

  seed(store, 'b'); seed(store, 'c');
  // Fixed order for the assertion: c spoken to last, then b, then only.
  await store.send('only', 'x'); await sleep(5);
  await store.send('b', 'x'); await sleep(5);
  await store.send('c', 'x');
  assert.deepEqual(store.list().map((e) => e.id), ['c', 'b', 'only']);

  store.activate('c');
  assert.equal(store.next(1)?.id, 'b', 'tab goes down the list');
  assert.equal(store.next(-1)?.id, 'only', 'shift+tab wraps the other way');
});

test('close takes a session out of local memory, and refuses one mid-turn', async () => {
  const store = new SessionStore(scriptedRun({ text: 'still going', hold: 60 }));
  seed(store, 's1'); seed(store, 's2'); seed(store, 's3');

  // Closing one you are not looking at: it leaves the ring, nothing else moves.
  store.activate('s1');
  assert.equal(store.close('s2'), true);
  assert.deepEqual(store.list().map((e) => e.id), ['s3', 's1'], 'gone from the ring');
  assert.equal(store.has('s2'), false, 'and so the dot on /resume goes');
  assert.equal(store.activeId, 's1', 'the screen did not move');

  // Closing the one on screen empties the screen: the store never picks the
  // next session itself — App does, through switchTo (see the /close test).
  assert.equal(store.close('s1'), true);
  assert.equal(store.activeId, '');
  assert.equal(store.list().length, 1);
  assert.equal(store.close('s3'), true);
  assert.equal(store.list().length, 0);

  // A turn running here refuses: its stream has nowhere else to land.
  seed(store, 's4');
  const running = store.send('s4', 'ask');
  assert.equal(store.close('s4'), false, 'refused while it works');
  assert.equal(store.has('s4'), true);
  await running;
  assert.equal(store.close('s4'), true, 'and allowed once it is done');
});

test('a turn on a background session lands in THAT session, not the one on screen', async () => {
  const store = new SessionStore(scriptedRun({ text: 'answer for two', hold: 60 }));
  seed(store, 's1'); seed(store, 's2');

  const running = store.send('s2', 'ask two');
  store.activate('s1');                       // look away while it works
  assert.equal(store.get('s2')?.busy, true, 'it keeps running');
  await running;

  const two = store.get('s2')!;
  const one = store.get('s1')!;
  assert.ok(two.done.some((p) => p.kind === 'text' && p.text.includes('answer for two')),
    'the answer is in the session that was asked');
  assert.ok(!one.done.some((p) => p.kind === 'text'),
    'and nothing leaked into the session on screen');
  assert.deepEqual(one.history, [], 'nor into its history');
  assert.equal(two.history.filter((m) => m.role === 'user').length, 1);
});

test('finishing out of sight leaves a mark; switching to it clears the mark', async () => {
  const store = new SessionStore(scriptedRun({ text: 'done', hold: 30 }));
  seed(store, 's1'); seed(store, 's2');
  const running = store.send('s2', 'go');
  store.activate('s1');
  await running;
  assert.equal(store.get('s2')?.unseen, true, 'something to come back to');
  store.activate('s2');
  assert.equal(store.get('s2')?.unseen, false, 'reading it clears it');
});

test('one failure, one line: a stream-reported error silences the catch; a throw with no stream report still lands', async () => {
  // The SDK reports one failed call through TWO doors — an `error` event in
  // the stream AND the turn's promise rejecting. The pane must show it once.
  const both: RunTurn = (async (_agent, _messages, onParts) => {
    onParts([{ type: 'error', error: new Error('API key is invalid.') } as never]);
    throw new Error('API key is invalid.');
  }) as RunTurn;
  const store = new SessionStore(both);
  seed(store, 's1');
  await store.send('s1', 'hello');
  const errors = store.get('s1')!.done.filter((p) => p.kind === 'error');
  assert.equal(errors.length, 1, 'the in-place stream report wins; the catch stays quiet');
  assert.match((errors[0] as { message: string }).message, /API key is invalid/);

  // A failure the stream never saw (a crash before it starts) still reports —
  // the catch is the only coverage there.
  const thrown = new SessionStore(scriptedRun({ throws: 'exploded before the stream' }));
  seed(thrown, 's2');
  await thrown.send('s2', 'hello');
  assert.equal(thrown.get('s2')!.done.filter((p) => p.kind === 'error').length, 1);
});

test('a background turn that FAILS is marked too — it must not look idle', async () => {
  const store = new SessionStore(scriptedRun({ throws: 'model exploded', hold: 20 }));
  seed(store, 's1'); seed(store, 's2');
  const running = store.send('s2', 'go');
  store.activate('s1');
  await running;
  const two = store.get('s2')!;
  assert.equal(two.busy, false);
  assert.equal(two.unseen, true, 'a session that fell over is still worth a look');
  assert.ok(two.done.some((p) => p.kind === 'error' && /model exploded/.test(p.message)));
});

test('a finished turn leaves its elapsed total — "✻ Worked for Ns"', async () => {
  const store = new SessionStore(scriptedRun({ text: 'ok', hold: 30 }));
  seed(store, 's1');
  await store.send('s1', 'go');
  const done = store.get('s1')!.done;
  const last = done[done.length - 1];
  assert.equal(last.kind, 'worked', 'the turn ends on its total');
  const worked = last as Extract<typeof last, { kind: 'worked' }>;
  assert.ok(worked.ms >= 30, 'the held time was counted');
  assert.ok(Date.now() - worked.at < 5_000, 'the finish clock is when the turn ended');
});

test('an interrupted turn gets its total too — the time was spent', async () => {
  const store = new SessionStore(scriptedRun({ text: 'late', hold: 200 }));
  seed(store, 's1');
  const running = store.send('s1', 'go');
  await sleep(20);
  store.abortTurn('s1');
  await running;
  const done = store.get('s1')!.done;
  assert.equal(done[done.length - 1].kind, 'worked');
});

test('interrupting stops the named session and leaves the others running', async () => {
  const store = new SessionStore(scriptedRun({ text: 'late', hold: 200 }));
  seed(store, 's1'); seed(store, 's2');
  const a = store.send('s1', 'one');
  const b = store.send('s2', 'two');
  await sleep(20);
  store.abortTurn('s1');
  await a;
  assert.equal(store.get('s1')?.busy, false, 's1 stopped');
  assert.equal(store.get('s2')?.busy, true, 's2 was not touched');
  assert.ok(!store.get('s1')!.done.some((p) => p.kind === 'error'),
    'an interrupt is not an error');
  await b;
});

test('quitting stops every session, not just the one on screen', async () => {
  const store = new SessionStore(scriptedRun({ text: 'late', hold: 300 }));
  seed(store, 's1'); seed(store, 's2');
  const a = store.send('s1', 'one');
  const b = store.send('s2', 'two');
  await sleep(20);
  store.abortAll();
  await Promise.all([a, b]);
  // Nothing left holding a request open — that is what lets node exit.
  assert.deepEqual(store.list().map((e) => e.busy), [false, false]);
  assert.deepEqual(store.list().map((e) => e.abort), [null, null]);
});

test('a second message to a session already working is refused, not queued', async () => {
  const store = new SessionStore(scriptedRun({ text: 'first', hold: 60 }));
  seed(store, 's1');
  const a = store.send('s1', 'one');
  await sleep(10);
  await store.send('s1', 'two');
  await a;
  assert.deepEqual(
    store.get('s1')!.history.filter((m) => m.role === 'user').map((m) => m.content),
    ['one'], 'the second never became a user message');
});

test('a lock held elsewhere REFUSES the message — the queue is only for this window\'s own turn', async () => {
  const store = new SessionStore(scriptedRun({ text: 'ok' }));
  store.onTurnStart = async () => { throw new Error('session_locked: held by supervisor'); };
  seed(store, 's1');
  await store.send('s1', 'hello there');
  const e = store.get('s1')!;
  assert.deepEqual(e.queue, [], 'nothing queued behind a lock someone else holds');
  assert.equal(e.busy, false, 'no turn started');
  assert.equal(e.history.filter((m) => m.role === 'user').length, 0, 'never became a user message');
  const note = e.done.find((p) => p.kind === 'note') as { text: string } | undefined;
  assert.match(note!.text, /not sent — session in use elsewhere/, 'the refusal says why');
  assert.match(note!.text, /"hello there"/, 'the words are in the note, not silently gone');
});

test('said while busy is queued, then sent TOGETHER as one turn when it ends', async () => {
  let turns = 0;
  const counting: RunTurn = (async (...args) => { turns++; return scriptedRun({ text: 'ok', hold: 40 })(...args); }) as RunTurn;
  const store = new SessionStore(counting);
  seed(store, 's1');
  store.say('s1', 'one');                      // runs now
  await sleep(10);
  store.say('s1', 'two');                      // queued
  store.say('s1', 'three');                    // queued behind it
  assert.deepEqual(store.get('s1')!.queue, ['two', 'three'], 'held, in order');
  assert.equal(store.get('s1')!.history.filter((m) => m.role === 'user').length, 1, 'not yet said');
  await sleep(160);
  const said = store.get('s1')!.history.filter((m) => m.role === 'user').map((m) => m.content);
  assert.deepEqual(said, ['one', 'two', 'three'], 'all said, in order');
  assert.equal(turns, 2, 'one turn for "one", ONE turn for everything queued behind it');
  assert.deepEqual(store.get('s1')!.queue, [], 'nothing left waiting');
});

test('interrupting does not fire the next queued line into the stopped session', async () => {
  const store = new SessionStore(scriptedRun({ text: 'ok', hold: 200 }));
  seed(store, 's1');
  store.say('s1', 'one');
  await sleep(10);
  store.say('s1', 'two');
  store.abortTurn('s1');
  await sleep(60);
  assert.equal(store.get('s1')!.busy, false, 'stopped');
  assert.deepEqual(store.get('s1')!.queue, ['two'], 'still queued — esc means stop, not "go on"');
});

test('the last queued line can be taken back to edit', () => {
  const store = new SessionStore(scriptedRun({ hold: 100 }));
  seed(store, 's1');
  store.say('s1', 'one');
  store.say('s1', 'two'); store.say('s1', 'three');
  assert.equal(store.unqueue('s1'), 'three');
  assert.deepEqual(store.get('s1')!.queue, ['two']);
  store.abortTurn('s1');
});

test('/model rebuilds every open session, not just the one on screen', () => {
  const store = new SessionStore(scriptedRun());
  seed(store, 's1'); seed(store, 's2');
  store.rebuildAgents(() => ({
    agent: { id: 'rebuilt' } as never,
    summary: { ...summary, model: 'fake-2' },
  }));
  assert.deepEqual(store.list().map((e) => e.summary.model), ['fake-2', 'fake-2']);
  assert.deepEqual(store.list().map((e) => (e.agent as unknown as { id: string }).id),
    ['rebuilt', 'rebuilt']);
});

test('each session writes to its own transcript', async () => {
  const store = new SessionStore(scriptedRun({ text: 'hi' }));
  const one = seed(store, 's1');
  const two = seed(store, 's2');
  assert.notEqual(one.transcript.path, two.transcript.path);
  await store.send('s1', 'only in one');
  const { readFileSync, existsSync } = await import('node:fs');
  assert.match(readFileSync(one.transcript.path, 'utf8'), /only in one/);
  assert.ok(!existsSync(two.transcript.path), 'a session nobody spoke to writes no file');
});

// ── the switcher's rows ─────────────────────────────────────────────────────

test('a row says what its session is doing, in one column', async () => {
  const store = new SessionStore(scriptedRun({ text: 'x', hold: 100 }));
  seed(store, 's1'); seed(store, 's2'); seed(store, 's3');
  const running = store.send('s2', 'working on it');
  store.activate('s1');
  await sleep(20);

  const rows = switcherChoices(store.list(), store.activeId,
    [{ id: 'w1', owner: 'sg', name: 'widgets' }]);
  const by = (id: string) => rows.find((r) => r.value === id)!;
  assert.match(String(by('s2').detail), /working…/);
  assert.equal(by('s2').busy, true, 'busy is what draws the spinner on the row');
  assert.match(String(by('s2').detail), /"working on it"/, 'and what it was asked');
  assert.match(String(by('s3').detail), /nothing said yet/);
  assert.match(String(by('s1').detail), /you are here/, 'the session you are in says so');
  assert.match(by('s2').label, /widgets · agent\/s2/,
    'a row names its session, not just its workspace — two in one workspace must differ');
  await running;
  const after = switcherChoices(store.list(), store.activeId, []);
  assert.match(String(after.find((r) => r.value === 's2')!.detail), /● answered/);
  assert.equal(after.find((r) => r.value === 's2')!.busy, false, 'the spinner stops with the turn');
});

test('the last thing you said comes off the history already in memory', () => {
  assert.equal(lastSaid({ history: [] }), undefined);
  assert.equal(lastSaid({ history: [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: [{ type: 'text', text: '  second\n  thing ' }] },
  ] }), 'second thing', 'newest first, whitespace collapsed, array content read');
});

// ── the keys, through Ink ───────────────────────────────────────────────────

const INITIAL = {
  sessionId: 's1', branch: 'agent/s1', workspaceId: 'w1',
  tools: {} as Record<string, Tool>, resumed: [] as ModelMessage[],
};

/** An App with two sessions open: launched into s1, then /new for s2. The
 *  banner no longer names the session, so which one is on screen is read
 *  through onSession — the same channel index.tsx tracks it by. */
async function twoSessions(over: Partial<Parameters<typeof App>[0]> = {}) {
  const api = async (method: string, path: string) => {
    if (path === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'widgets' }];
    if (path.split('?')[0] === '/sessions' && method === 'GET') return { sessions: [], total: ([]).length };
    return { id: 's2', branch: 'agent/s2', workspaceId: 'w1', status: 'active' };
  };
  const active = { id: 's1', branch: 'agent/s1' };
  const r = render(<App api={api as never} initial={INITIAL} newTools={async () => ({})} makeVoice={inertVoice}
    makeAgent={stubAgent} makeTranscript={(h) => new Transcript(h, tmp())}
    loadHistory={() => []} run={scriptedRun({ text: 'hello' })}
    onSession={(s) => { active.id = s.id; active.branch = s.branch; }} {...over} />);
  await sleep(50);
  r.stdin.write('/new'); await sleep(40);
  r.stdin.write(ENTER); await sleep(160);
  assert.equal(active.id, 's2', 'setup: two are open, s2 on screen');
  return Object.assign(r, { active });
}

test('a turn that ends ships the transcript file to the server, whole', async () => {
  const puts: { path: string; data: string }[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    if (method === 'PUT' && path.endsWith('/transcript')) puts.push({ path, data: (body as { data: string }).data });
    if (path === '/workspaces' || path.split('?')[0] === '/sessions') return { sessions: [], total: ([]).length };
    return {};
  };
  const file = tmp();
  const r = render(<App api={api as never} initial={INITIAL} newTools={async () => ({})} makeVoice={inertVoice}
    makeAgent={stubAgent} makeTranscript={(h) => new Transcript(h, file)}
    loadHistory={() => []} run={scriptedRun({ text: 'answer' })} />);
  await sleep(50);
  r.stdin.write('hello'); await sleep(30);
  r.stdin.write('\r'); await sleep(250);
  assert.equal(puts.length, 1, 'one upload per settled turn');
  assert.equal(puts[0].path, '/sessions/s1/transcript');
  assert.equal(puts[0].data, readFileSync(file, 'utf8'), 'the local file, byte for byte');
  assert.match(puts[0].data, /"hello"/);
  assert.match(puts[0].data, /"answer"/);
  r.unmount();
});

// The relay: this window's own turn goes up to the server as it runs, so a
// watcher anywhere sees it stream — the same records the server publishes
// for a turn it runs, in the same order, and turn-end BEFORE the record.
test('a turn this window runs is relayed as it runs: turn-start, each flush of parts, turn-end, then the upload', async () => {
  const log: string[] = [];
  const store = new SessionStore(scriptedRun({ text: 'typed here' }), () => { log.push('upload'); });
  const relayed: Record<string, unknown>[][] = [];
  store.relay = async (id, events) => {
    assert.equal(id, 's1');
    relayed.push(events);
    log.push(events.map((e) => String(e.event)).join(','));
  };
  seed(store, 's1');
  await store.send('s1', 'hello');
  await sleep(10);
  assert.deepEqual(relayed[0], [{ event: 'turn-start', agent: 'coding', message: 'hello' }]);
  const parts = relayed.slice(1, -1).flat().map((e) => e.part as { type: string; text?: string });
  assert.ok(parts.some((p) => p.type === 'text-delta' && p.text === 'typed here'), 'every drawn part rides, verbatim');
  assert.deepEqual(relayed.at(-1), [{ event: 'turn-end' }]);
  assert.equal(log.indexOf('turn-end') < log.indexOf('upload'), true,
    'the turn closes on the feed before the record lands — a watcher can keep its screen');
});

test('a relay that fails stops for the turn and never touches the turn itself', async () => {
  const store = new SessionStore(scriptedRun({ text: 'still answered' }));
  const calls: string[] = [];
  store.relay = async (_id, events) => { calls.push(String(events[0].event)); throw new Error('server away'); };
  seed(store, 's1');
  await store.send('s1', 'hello');
  await sleep(10);
  const e = store.get('s1')!;
  assert.ok(e.done.some((p) => p.kind === 'text' && /still answered/.test(String((p as { text?: string }).text ?? ''))),
    'the reply landed on this screen');
  assert.ok(!e.done.some((p) => p.kind === 'error' || p.kind === 'note'), 'no error, no note — the relay is not the turn');
  assert.deepEqual(calls, ['turn-start'], 'after the first failure nothing more is sent this turn');
});

/** A hand-driven session feed: the test pushes records, the app reads them. */
function fakeFeed(expectPath?: string) {
  const queue: Record<string, unknown>[] = [];
  let deliver: (() => void) | null = null;
  const push = (rec: Record<string, unknown>) => { queue.push(rec); deliver?.(); };
  const stream = async (path: string, signal: AbortSignal) => {
    if (expectPath) assert.equal(path, expectPath, 'the feed follows the session on screen');
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) yield queue.shift()!;
          if (signal.aborted) return;
          await new Promise<void>((res) => {
            deliver = res;
            signal.addEventListener('abort', () => res(), { once: true });
          });
          deliver = null;
        }
      },
    };
  };
  return { push, stream };
}

test('a session locked elsewhere is watched: read-only prompt, a spinner off the feed, repaint when it moves, cleared on release or expiry', async () => {
  const sid = 'watch-1';
  const header = JSON.stringify({ type: 'session', session_id: sid, provider: 'test', model: 'fake', created_at: '2026-08-27T00:00:00.000Z' });
  let stamp = 't1';
  let lines = [header, JSON.stringify({ role: 'assistant', content: 'round one landed' })];
  const api = async (method: string, path: string) => {
    if (path === '/workspaces' || (path.split('?')[0] === '/sessions' && method === 'GET')) return { sessions: [], total: ([]).length };
    if (path === `/sessions/${sid}` && method === 'GET') return { id: sid, transcript_updated_at: stamp };
    if (path === `/sessions/${sid}/transcript`) return { data: lines.join('\n'), updated_at: stamp };
    return {};
  };
  const { push, stream } = fakeFeed(`/sessions/${sid}/events`);
  const r = render(<App api={api as never} stream={stream as never}
    initial={{ ...INITIAL, sessionId: sid, branch: `agent/${sid}` }}
    newTools={async () => ({})} makeVoice={inertVoice} makeAgent={stubAgent}
    makeTranscript={(h) => new Transcript(h, tmp())} loadHistory={() => []}
    run={scriptedRun()} pollMs={120} clientId="me" />);
  try {
    // The feed's first record: who holds it. No poll, no delay.
    const far = new Date(Date.now() + 60_000).toISOString();
    push({ event: 'lock', locked: true, by: 'looper-round', label: 'building', agent: 'coding', expires_at: far });
    await sleep(80);
    let f = strip(r.lastFrame()!);
    // A spinner and the one word the holder gave for the work — no sentence
    // about locks, and nothing about another session.
    assert.match(f, /coding agent .* building/, 'the toolbar spins on who is working and what they are doing');
    assert.doesNotMatch(f, /in use|checking again/, 'no lock prose under the prompt');
    assert.match(f, /round one landed/, 'the elsewhere work is on screen');
    // Typing is refused — and the line stays in the prompt, not swallowed.
    r.stdin.write('hey'); await sleep(20);
    r.stdin.write(ENTER); await sleep(40);
    f = strip(r.lastFrame()!);
    assert.match(f, /not sent — a turn is running \(building\)/, 'refused, with why');
    assert.match(f, /hey/, 'the typed line is still in the prompt');
    // The transcript moves; the next look repaints the new lump.
    lines = [...lines, JSON.stringify({ role: 'assistant', content: 'round two landed' })];
    stamp = 't2';
    await sleep(250);
    assert.match(strip(r.lastFrame()!), /round two landed/, 'the next look re-rendered it');
    // The holder lets go: the feed says so, the toolbar line goes at once.
    push({ event: 'lock', locked: false, by: null, label: null, agent: 'coding', expires_at: null });
    await sleep(60);
    assert.ok(!/building/.test(strip(r.lastFrame()!)), 'freed — the prompt is ordinary again');
    // A holder that DIED: no release ever comes, but the hold has an expiry
    // and this window clears it on its own clock.
    push({ event: 'lock', locked: true, by: 'macbook', label: 'macbook', agent: null,
      expires_at: new Date(Date.now() + 700).toISOString() });
    await sleep(60);
    assert.match(strip(r.lastFrame()!), /macbook/, 'held again — a hostname, no who');
    await sleep(1200);   // past the expiry and the once-a-second tick
    assert.ok(!/macbook/.test(strip(r.lastFrame()!)), 'lapsed on this clock — no spinner for a dead holder');
  } finally { r.unmount(); }
});

test('joining a turn already running: the parts alone start the working line — no turn-start needed', async () => {
  const sid = 'join-1';
  const api = async (method: string, path: string) => {
    if (path === '/workspaces' || (path.split('?')[0] === '/sessions' && method === 'GET')) return { sessions: [], total: ([]).length };
    if (path === `/sessions/${sid}` && method === 'GET') return { id: sid, transcript_updated_at: null };
    return {};
  };
  const { push, stream } = fakeFeed();
  const r = render(<App api={api as never} stream={stream as never}
    initial={{ ...INITIAL, sessionId: sid, branch: `agent/${sid}` }}
    newTools={async () => ({})} makeVoice={inertVoice} makeAgent={stubAgent}
    makeTranscript={(h) => new Transcript(h, tmp())} loadHistory={() => []}
    run={scriptedRun()} pollMs={5000} clientId="me" />);
  try {
    await sleep(60);
    // No turn-start — it went by before this window connected (no replay).
    push({ event: 'part', part: { type: 'text-start', id: '0' } });
    push({ event: 'part', part: { type: 'text-delta', id: '0', text: 'mid-turn words' } });
    await sleep(250);
    const f = strip(r.lastFrame()!);
    assert.match(f, /mid-turn words/, 'the rest of the turn is drawn');
    assert.match(f, /Working…/, 'and the working line runs from the first part');
  } finally { r.unmount(); }
});

// The session feed: a turn the SERVER runs is drawn here as it happens,
// through the same reducer a local turn uses. The turn-end refresh takes the
// record but LEAVES THE SCREEN — we watched the whole thing, and a repaint
// would only drop the detail we saw and make the pane jump.
test('a remote turn streams into the pane as it happens, and the record lands without repainting it', async () => {
  const sid = 'feed-1';
  const header = JSON.stringify({ type: 'session', session_id: sid, provider: 'test', model: 'fake', created_at: '2026-08-27T00:00:00.000Z' });
  let stamp = 't1';
  let lines = [header];
  const api = async (method: string, path: string) => {
    if (path === '/workspaces' || (path.split('?')[0] === '/sessions' && method === 'GET')) return { sessions: [], total: ([]).length };
    // The poll carries NO stamp here: this test is about the feed, and the
    // poll's own pull is the path the next test covers.
    if (path === `/sessions/${sid}` && method === 'GET')
      return { id: sid, locked: true, lockedBy: 'looper-round', lockedLabel: 'building', transcript_updated_at: null };
    if (path === `/sessions/${sid}/transcript`) return { data: lines.join('\n'), updated_at: stamp };
    return {};
  };
  // The feed, as records the server would send. Pushed by hand so the test
  // drives the timing.
  const queue: Record<string, unknown>[] = [];
  let deliver: (() => void) | null = null;
  const push = (rec: Record<string, unknown>) => { queue.push(rec); deliver?.(); };
  const stream = async (path: string, signal: AbortSignal) => {
    assert.equal(path, `/sessions/${sid}/events`, 'the feed follows the session on screen');
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) yield queue.shift()!;
          if (signal.aborted) return;
          await new Promise<void>((res) => {
            deliver = res;
            signal.addEventListener('abort', () => res(), { once: true });
          });
          deliver = null;
        }
      },
    };
  };
  const part = (p: Record<string, unknown>) => push({ event: 'part', part: p });
  const r = render(<App api={api as never} stream={stream as never}
    initial={{ ...INITIAL, sessionId: sid, branch: `agent/${sid}` }}
    newTools={async () => ({})} makeVoice={inertVoice} makeAgent={stubAgent}
    makeTranscript={(h) => new Transcript(h, tmp())} loadHistory={() => []}
    run={scriptedRun()} pollMs={5000} clientId="me" />);
  try {
    await sleep(60);
    push({ event: 'turn-start', agent: 'coding', message: 'build the thing' });
    part({ type: 'text-start', id: '0' });
    part({ type: 'text-delta', id: '0', text: 'working on it' });
    await sleep(250);   // past the 150ms delta batch
    let f = strip(r.lastFrame()!);
    assert.match(f, /build the thing/, 'the message the agent is answering is on screen');
    assert.match(f, /working on it/, 'the reply is drawn as it streams — no waiting for the turn to end');
    assert.match(f, /Working…/, 'the working line runs, so a long silent tool call is not a frozen screen');
    assert.doesNotMatch(f, /to interrupt/, 'but esc is not offered: it cannot stop someone else\'s turn');

    // The turn ends and the record lands. The screen keeps what it drew.
    part({ type: 'text-end', id: '0' });
    push({ event: 'turn-end' });
    lines = [...lines, JSON.stringify({ role: 'user', content: 'build the thing' }),
      JSON.stringify({ role: 'assistant', content: 'working on it' })];
    stamp = 't2';
    push({ event: 'transcript', updated_at: stamp, by: 'looper-round' });
    await sleep(200);
    f = strip(r.lastFrame()!);
    assert.match(f, /working on it/, 'the turn is still there');
    assert.doesNotMatch(f, /moved forward elsewhere/,
      'and no refresh note: nothing moved forward unseen — we watched it happen');
    assert.doesNotMatch(f, /Working…/, 'the working line is gone with the turn');
  } finally { r.unmount(); }
});

test('the feed repaints from the record when this window did NOT see the whole turn', async () => {
  const sid = 'feed-2';
  const header = JSON.stringify({ type: 'session', session_id: sid, provider: 'test', model: 'fake', created_at: '2026-08-27T00:00:00.000Z' });
  const lines = [header, JSON.stringify({ role: 'assistant', content: 'the recorded answer' })];
  const api = async (method: string, path: string) => {
    if (path === '/workspaces' || (path.split('?')[0] === '/sessions' && method === 'GET')) return { sessions: [], total: ([]).length };
    if (path === `/sessions/${sid}` && method === 'GET') return { id: sid, locked: false, transcript_updated_at: null };
    if (path === `/sessions/${sid}/transcript`) return { data: lines.join('\n'), updated_at: 't2' };
    return {};
  };
  const queue: Record<string, unknown>[] = [];
  let deliver: (() => void) | null = null;
  const push = (rec: Record<string, unknown>) => { queue.push(rec); deliver?.(); };
  const stream = async (_path: string, signal: AbortSignal) => ({
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (signal.aborted) return;
        await new Promise<void>((res) => {
          deliver = res;
          signal.addEventListener('abort', () => res(), { once: true });
        });
        deliver = null;
      }
    },
  });
  const r = render(<App api={api as never} stream={stream as never}
    initial={{ ...INITIAL, sessionId: sid, branch: `agent/${sid}` }}
    newTools={async () => ({})} makeVoice={inertVoice} makeAgent={stubAgent}
    makeTranscript={(h) => new Transcript(h, tmp())} loadHistory={() => []}
    run={scriptedRun()} pollMs={5000} clientId="me" />);
  try {
    await sleep(60);
    // Never saw a turn-start — another window did this work. The record is
    // the only thing that can be trusted, so it repaints, note and all.
    push({ event: 'transcript', updated_at: 't2', by: 'another-window' });
    await sleep(200);
    const f = strip(r.lastFrame()!);
    assert.match(f, /the recorded answer/, 'the record is on screen');
    assert.match(f, /moved forward elsewhere/, 'and it says so — this work arrived unseen');

    // A turn that started here but never ENDED here — a relay that died
    // mid-turn — is a hole too: the screen is missing its tail.
    push({ event: 'turn-start', agent: 'coding', message: 'half a turn' });
    push({ event: 'part', part: { type: 'text-start', id: '1' } });
    push({ event: 'part', part: { type: 'text-delta', id: '1', text: 'then silence' } });
    await sleep(200);
    assert.match(strip(r.lastFrame()!), /then silence/, 'setup: the half turn is on screen');
    push({ event: 'transcript', updated_at: 't3', by: 'another-window' });
    await sleep(200);
    const f2 = strip(r.lastFrame()!);
    assert.doesNotMatch(f2, /then silence/, 'no turn-end seen: the screen is replaced by the record');
    assert.match(f2, /the recorded answer/);
  } finally { r.unmount(); }
});

test('session_get_mode answers from the sessions table: a background session whose row moved is reported, and this window follows it', async () => {
  // The ROWS, as the server holds them. s1 is launched into, s2 goes on screen;
  // the elsewhere-watch polls only what is ON SCREEN, so once s1 is in the
  // background nothing in this window can learn that its row moved — which is
  // exactly the case a mirror-reading tool answers wrongly.
  const rows: Record<string, { planMode: boolean }> = { s1: { planMode: false }, s2: { planMode: false } };
  const api = async (method: string, path: string) => {
    if (path === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'widgets' }];
    if (path.split('?')[0] === '/sessions' && method === 'GET') return { sessions: [], total: ([]).length };
    const one = /^\/sessions\/(s\d)$/.exec(path);
    if (one && method === 'GET') return { id: one[1], ...rows[one[1]] };
    return { id: 's2', branch: 'agent/s2', workspaceId: 'w1', status: 'active' };
  };
  const kits: Record<string, Tool>[] = [];
  const capture = (tools?: unknown) => { kits.push(tools as Record<string, Tool>); return stubAgent(); };
  const active = { id: 's1' };
  const r = render(<App api={api as never} initial={INITIAL} newTools={async () => ({})}
    makeVoice={inertVoice} makeAgent={capture} makeTranscript={(h) => new Transcript(h, tmp())}
    loadHistory={() => []} run={scriptedRun()} onSession={(s) => { active.id = s.id; }} />);
  try {
    await sleep(50);
    const t = kits[0]['session_get_mode'] as unknown as
      { execute: (a: unknown, o: unknown) => Promise<unknown> };
    assert.deepEqual(await t.execute({}, {}), { mode: 'code' }, 'row and window agree');
    // s2 takes the screen; s1 keeps running in the background.
    r.stdin.write('/new'); await sleep(40);
    r.stdin.write(ENTER); await sleep(200);
    assert.equal(active.id, 's2', 'setup: s1 is no longer the watched session');
    const built = kits.length;
    // The looper (or another machine) puts s1 in plan mode.
    rows.s1.planMode = true;
    await sleep(120);
    assert.deepEqual(await t.execute({}, {}), { mode: 'plan' },
      "the sessions table is the answer, not this window's copy of it");
    assert.ok(kits.length > built,
      'and the window FOLLOWED the row: s1 was rebuilt with the plan-mode kit');
  } finally { r.unmount(); }
});

test("a coding session carries the board tool, bound to ITS workspace and not the screen's", async () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const cards = [{ id: 11, seq: 1, status: 'backlog', pos: 1, title: 'a card', details: 'd',
    user_story: 'as a user', requirements: [{ text: 'works', done: false }, { text: 'step', done: false }],
    blocked_reason: null, archived: false,
    created_at: '2026-08-23', updated_at: '2026-08-23' }];
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (path === '/workspaces') return [{ id: 'w2', owner: 'sg', name: 'gadgets' }];
    if (path.split('?')[0] === '/sessions' && method === 'GET') return { sessions: [], total: ([]).length };
    if (path.includes('/cards')) return { prefix: 'PHA', columns: ['backlog', 'review'], cards, card: cards[0] };
    return { id: 's2', branch: 'agent/s2', workspaceId: 'w2', status: 'active' };
  };
  const kits: Record<string, Tool>[] = [];
  const capture = (tools?: unknown) => { kits.push(tools as Record<string, Tool>); return stubAgent(); };
  const active = { id: 's1' };
  const r = render(<App api={api as never} initial={INITIAL} newTools={async () => ({})}
    makeVoice={inertVoice} makeAgent={capture} makeTranscript={(h) => new Transcript(h, tmp())}
    loadHistory={() => []} run={scriptedRun()} onSession={(s) => { active.id = s.id; }} />);
  try {
    await sleep(50);
    // s1 (workspace w1) launched with the board tool and the screen pair.
    assert.deepEqual(Object.keys(kits[0]), ['kanban_card_read', 'session_get_mode', 'screen_enter_plan_mode'],
      'the coding agent reads cards and the screen mode, nothing else');
    // Open a second session in ANOTHER workspace and leave it on screen.
    r.stdin.write('/new'); await sleep(40);
    r.stdin.write(ENTER); await sleep(200);
    assert.equal(active.id, 's2');
    const t = (name: string) => kits[0][name] as { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> };
    const got = await t('kanban_card_read').execute({ card: 1 }, { toolCallId: 't', messages: [] });
    assert.equal(got.user_story, 'as a user', 'get returns the whole card, for planning');
    assert.deepEqual(got.requirements, [{ text: 'works', done: false }, { text: 'step', done: false }]);
    // Bound to s1's OWN workspace, not the one on screen: the read above hit
    // w1's board even while s2 (another workspace) is active.
    const reads = calls.filter((c) => (c as { path?: string }).path?.includes('/workspaces/w1/cards'));
    assert.ok(reads.length >= 1, "s1's tool read s1's workspace, not the one on screen");
  } finally { r.unmount(); }
});

test('tab moves to the other session and shift+tab comes back', async () => {
  const r = await twoSessions();
  try {
    r.stdin.write(TAB); await sleep(120);
    assert.deepEqual(r.active, { id: 's1', branch: 'agent/s1' }, 'tab switched');
    r.stdin.write(SHIFT_TAB); await sleep(120);
    assert.deepEqual(r.active, { id: 's2', branch: 'agent/s2' }, 'shift+tab came back');
  } finally { r.unmount(); }
});

test('tab completes a slash command instead of switching while one is typed', async () => {
  const r = await twoSessions();
  try {
    r.stdin.write('/set'); await sleep(60);
    r.stdin.write(TAB); await sleep(120);
    const f = strip(r.lastFrame() ?? '');
    assert.match(f, /> \/settings/, 'tab completed the command');
    assert.equal(r.active.id, 's2', 'and did not switch session');
  } finally { r.unmount(); }
});

test('with one session open, tab says so rather than doing nothing', async () => {
  const r = render(<App api={(async () => ({})) as never} initial={INITIAL}
    newTools={async () => ({})} makeVoice={inertVoice} makeAgent={stubAgent}
    makeTranscript={(h) => new Transcript(h, tmp())} loadHistory={() => []}
    run={scriptedRun()} />);
  try {
    await sleep(50);
    r.stdin.write(TAB); await sleep(100);
    assert.match(strip(r.frames.join('\n')), /only session open/);
  } finally { r.unmount(); }
});

test('ctrl+n opens the list of open sessions, esc puts the prompt back', async () => {
  const r = await twoSessions();
  try {
    r.stdin.write(CTRL_N); await sleep(140);
    const f = strip(r.lastFrame() ?? '');
    assert.match(f, /open sessions/);
    assert.match(f, /agent\/s1/, 'both are listed');
    assert.ok(!/type a message/.test(f), 'the list replaces the prompt');
    r.stdin.write(ESC); await sleep(80);
    assert.match(strip(r.lastFrame() ?? ''), /type a message/);
  } finally { r.unmount(); }
});

test('ctrl+n types nothing into the prompt; shift+↑ is not a shortcut at all', async () => {
  const r = await twoSessions();
  try {
    r.stdin.write(CTRL_N); await sleep(140);
    assert.match(strip(r.lastFrame() ?? ''), /open sessions/, 'the list opened');
    r.stdin.write(ESC); await sleep(80);
    const f = strip(r.lastFrame() ?? '');
    assert.match(f, /type a message/, 'and the prompt is back');
    assert.ok(!/> n/.test(f), 'with nothing typed into it');
    // The old second door. Terminals disagree about whether it exists at all,
    // so it opens nothing here — it falls through to the history arrows.
    r.stdin.write(SHIFT_UP); await sleep(140);
    assert.ok(!/open sessions/.test(strip(r.lastFrame() ?? '')), 'shift+↑ opens nothing');
  } finally { r.unmount(); }
});

test('/close closes the session on screen and lands on the most recent one left', async () => {
  const r = await twoSessions();
  try {
    r.stdin.write('/close'); await sleep(40);
    r.stdin.write(ENTER); await sleep(200);
    assert.deepEqual(r.active, { id: 's1', branch: 'agent/s1' }, 's1 took the screen');
    // Gone from the ring: with one session left, tab has nowhere to go.
    r.stdin.write(TAB); await sleep(120);
    assert.match(strip(r.frames.join('\n')), /only session open/);
  } finally { r.unmount(); }
});

test('/close on the last session opens a new one rather than an empty window', async () => {
  const opened: string[] = [];
  let n = 2;
  const api = async (method: string, path: string) => {
    if (path === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'widgets' }];
    if (path.split('?')[0] === '/sessions' && method === 'GET') return { sessions: [], total: ([]).length };
    // Only creating a session mints one — every other call (locks, transcript
    // reads) must not, or the ids drift under the assertion.
    if (path === '/sessions' && method === 'POST') {
      const id = `s${++n}`;
      return { id, branch: `agent/${id}`, workspaceId: 'w1', status: 'active' };
    }
    return {};
  };
  const r = render(<App api={api as never} initial={INITIAL} newTools={async () => ({})}
    makeVoice={inertVoice} makeAgent={stubAgent} makeTranscript={(h) => new Transcript(h, tmp())}
    loadHistory={() => []} run={scriptedRun()} onSession={(s) => opened.push(s.id)} />);
  try {
    await sleep(60);                       // setup: launched into s1, alone
    r.stdin.write('/close'); await sleep(40);
    r.stdin.write(ENTER); await sleep(250);
    assert.deepEqual(opened, ['s3'], 'a fresh session opened — the window is never left empty');
    assert.match(strip(r.lastFrame() ?? ''), /type a message/, 'and the prompt is live in it');
  } finally { r.unmount(); }
});

test('picking a row in the list switches to that session', async () => {
  const r = await twoSessions();
  try {
    r.stdin.write(CTRL_N); await sleep(140);
    r.stdin.write(DOWN); await sleep(60);
    r.stdin.write(ENTER); await sleep(140);
    const f = strip(r.lastFrame() ?? '');
    assert.deepEqual(r.active, { id: 's1', branch: 'agent/s1' });
    assert.match(f, /type a message/, 'and the prompt is back');
  } finally { r.unmount(); }
});

test('an answer arrives in a session you tabbed away from, and is waiting on return', async () => {
  const r = await twoSessions({ run: scriptedRun({ text: 'the slow answer', hold: 150 }) });
  try {
    r.stdin.write('ask s2'); await sleep(40);
    r.stdin.write(ENTER); await sleep(40);
    r.stdin.write(TAB); await sleep(80);          // leave while it works
    assert.equal(r.active.id, 's1', 'we are elsewhere');
    await sleep(250);                             // it finishes out of sight
    // The toolbar speaks for THIS session only — the answer waiting in the
    // other one is the switcher's job (ctrl+n), not this line's.
    assert.doesNotMatch(strip(r.lastFrame() ?? ''), /elsewhere — \[ctrl\+n\]/,
      'no other-session chatter on the toolbar');
    r.stdin.write(TAB); await sleep(150);         // and back
    const f = strip(r.lastFrame() ?? '');
    assert.match(f, /the slow answer/, 'the answer was kept');
    assert.match(f, /ask s2/, 'along with what was asked');
  } finally { r.unmount(); }
});

test('↑ brings back what you said; a half-typed line is left alone', async () => {
  const r = await twoSessions();
  try {
    r.stdin.write('first thing'); await sleep(40);
    r.stdin.write(ENTER); await sleep(150);
    r.stdin.write('second thing'); await sleep(40);
    r.stdin.write(ENTER); await sleep(150);

    // Recall never starts from a line with something on it: ↑ there is a
    // cursor key, not a command to throw away what was typed.
    r.stdin.write('half typed'); await sleep(60);
    r.stdin.write(UP); await sleep(90);
    assert.match(strip(r.lastFrame() ?? ''), /> half typed/, 'a typed line is left alone');
    // One at a time: several bytes in one chunk reach Ink as pasted text, not
    // as keypresses.
    for (let i = 0; i < 'half typed'.length; i++) { r.stdin.write('\x7f'); await sleep(12); }
    assert.match(strip(r.lastFrame() ?? ''), /type a message/, 'the line is empty again');

    r.stdin.write(UP); await sleep(90);
    assert.match(strip(r.lastFrame() ?? ''), /> second thing/, 'newest first');
    r.stdin.write(UP); await sleep(90);
    assert.match(strip(r.lastFrame() ?? ''), /> first thing/, 'then the one before it');
    r.stdin.write(DOWN); await sleep(90);
    assert.match(strip(r.lastFrame() ?? ''), /> second thing/, '↓ walks back toward now');
    r.stdin.write(DOWN); await sleep(90);
    assert.match(strip(r.lastFrame() ?? ''), /type a message/, 'and off the end is the empty line');
  } finally { r.unmount(); }
});

test('history is the session you are in, not the one next to it', async () => {
  const r = await twoSessions();
  try {
    r.stdin.write('said to s2'); await sleep(40);
    r.stdin.write(ENTER); await sleep(180);
    r.stdin.write(TAB); await sleep(150);            // over to s1, which has said nothing
    r.stdin.write(UP); await sleep(100);
    const f = strip(r.lastFrame() ?? '');
    assert.equal(r.active.id, 's1');
    assert.ok(!/> said to s2/.test(f), "s1 does not recall s2's messages");
  } finally { r.unmount(); }
});

test('you can type while the agent works; enter queues and interrupt rides the working line', async () => {
  const r = await twoSessions({ run: scriptedRun({ text: 'slow', hold: 300 }) });
  try {
    r.stdin.write('go'); await sleep(30);
    r.stdin.write(ENTER); await sleep(60);
    let f = strip(r.lastFrame() ?? '');
    assert.match(f, /Working….*\[esc\] to interrupt/, 'the one key that stops the turn sits on the turn\'s own line');
    const promptAt = f.indexOf('> ');
    const hintAt = f.indexOf('[esc] to interrupt');
    assert.ok(promptAt > 0 && hintAt < promptAt, 'above the prompt, on the working line — not under it');
    assert.ok(!/queues for after this turn/.test(f), 'no commentary about what enter does');

    r.stdin.write('next thing'); await sleep(60);
    assert.match(strip(r.lastFrame() ?? ''), /> next thing/, 'typing works mid-turn');
    r.stdin.write(ENTER); await sleep(60);
    f = strip(r.lastFrame() ?? '');
    assert.match(f, /queued · sent together/, 'it is held');
    assert.match(f, /› next thing/, 'and listed');
    assert.match(f, /type a message/, 'prompt is empty again');

    // ↑ on the empty line takes it back to edit.
    r.stdin.write(UP); await sleep(80);
    assert.match(strip(r.lastFrame() ?? ''), /> next thing/, 'pulled back into the box');
    assert.ok(!/› next thing/.test(strip(r.lastFrame() ?? '')), 'and off the queue');
    r.stdin.write(ENTER); await sleep(60);   // queue it again

    await sleep(400);                         // first turn ends, queued one runs and ends
    f = strip(r.lastFrame() ?? '');
    assert.match(f, /› next thing/, 'it was sent as its own message');
    assert.ok(!/queued · sent/.test(f), 'queue is empty');
  } finally { r.unmount(); }
});

test('esc with a queue clears the queue first; the next esc stops the turn', async () => {
  const r = await twoSessions({ run: scriptedRun({ text: 'slow', hold: 600 }) });
  try {
    r.stdin.write('go'); await sleep(30); r.stdin.write(ENTER); await sleep(60);
    r.stdin.write('later'); await sleep(30); r.stdin.write(ENTER); await sleep(60);
    let f = strip(r.lastFrame() ?? '');
    assert.match(f, /› later/, 'queued');
    assert.match(f, /\[esc\] clears the queue, then interrupts/, 'and the hint says what esc will do');
    r.stdin.write(ESC); await sleep(80);
    f = strip(r.lastFrame() ?? '');
    assert.ok(!/› later/.test(f), 'first esc: queue gone');
    assert.match(f, /\[esc\] to interrupt/, 'turn still running, hint says so');
    r.stdin.write(ESC); await sleep(120);
    f = strip(r.lastFrame() ?? '');
    assert.ok(!/\[esc\] to interrupt/.test(f), 'second esc: turn stopped');
  } finally { r.unmount(); }
});

test('each session keeps its own conversation on screen', async () => {
  const r = await twoSessions();
  try {
    r.stdin.write('said to s2'); await sleep(40);
    r.stdin.write(ENTER); await sleep(200);
    assert.match(strip(r.lastFrame() ?? ''), /said to s2/);
    r.stdin.write(TAB); await sleep(150);
    const f = strip(r.lastFrame() ?? '');
    assert.equal(r.active.id, 's1');
    assert.ok(!/said to s2/.test(f), "s1's screen does not show s2's conversation");
    r.stdin.write(TAB); await sleep(150);
    assert.match(strip(r.lastFrame() ?? ''), /said to s2/, 'and s2 still has it on the way back');
  } finally { r.unmount(); }
});

// ── the frozen system prompt ─────────────────────────────────────────────────

test('a new session freezes its prompt into the header; resume replays it; rebuilds keep it', async () => {
  const file = tmp();
  const got: (string | undefined)[] = [];
  const seeingAgent: typeof stubAgent = (tools, configPath, instructions) => {
    got.push(instructions);
    return stubAgent(tools, configPath, instructions);
  };
  // Launch: no stored prompt → a fresh stack, written into the header.
  const r = render(<App api={(async () => ({})) as never} initial={INITIAL} newTools={async () => ({})}
    makeVoice={inertVoice} makeAgent={seeingAgent} makeTranscript={(h) => new Transcript(h, file)}
    loadHistory={() => []} run={scriptedRun({ text: 'hello' })} />);
  await sleep(50);
  assert.match(String(got[0]), /value-based coding agent/, 'fresh stack assembled');
  r.stdin.write('hi'); await sleep(30); r.stdin.write(ENTER); await sleep(160);
  const header = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]);
  assert.equal(header.system_prompt, got[0], 'the assembled prompt is stored with the session');
  r.unmount();

  // Resume: the STORED prompt wins over a fresh assembly, verbatim.
  const r2 = render(<App api={(async () => ({})) as never}
    initial={{ ...INITIAL, resumed: [{ role: 'user', content: 'hi' }] as ModelMessage[], instructions: 'FROZEN PROMPT' }}
    newTools={async () => ({})} makeVoice={inertVoice} makeAgent={seeingAgent}
    makeTranscript={(h) => new Transcript(h, tmp())} loadHistory={() => []} run={scriptedRun({ text: 'x' })} />);
  await sleep(50);
  assert.equal(got.at(-1), 'FROZEN PROMPT');
  r2.unmount();
});

test('the skill index freezes into the prompt: launch from initial.skills, /new from the create response', async () => {
  const got: (string | undefined)[] = [];
  const seeingAgent: typeof stubAgent = (tools, configPath, instructions) => {
    got.push(instructions);
    return stubAgent(tools, configPath, instructions);
  };
  // Launch: initial.skills (index.tsx already merged the tiers) lands in the stack.
  const r = render(<App api={(async () => ({})) as never}
    initial={{ ...INITIAL, skills: [{ name: 'deploy-checks', description: 'Use when deploying.' }] }}
    newTools={async () => ({})} makeVoice={inertVoice} makeAgent={seeingAgent}
    makeTranscript={(h) => new Transcript(h, tmp())} loadHistory={() => []} run={scriptedRun()} />);
  await sleep(50);
  assert.match(String(got[0]), /- deploy-checks: Use when deploying\./, 'launch freezes the index');
  r.unmount();

  // /new (the OTHER freeze site): the create response's list IS the index —
  // the server already merged the repo and system tiers (repo shadowing).
  const api = async (method: string, path: string) => {
    if (path === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'widgets' }];
    if (path.split('?')[0] === '/sessions' && method === 'GET') return { sessions: [], total: ([]).length };
    return { id: 's2', branch: 'agent/s2', workspaceId: 'w1', status: 'active',
      skills: [
        { name: 'deploy-checks', description: 'repo version' },
        { name: 'playwright-cli', description: 'system tier, merged by the server' },
      ] };
  };
  const r2 = render(<App api={api as never} initial={INITIAL} newTools={async () => ({})}
    makeVoice={inertVoice} makeAgent={seeingAgent} makeTranscript={(h) => new Transcript(h, tmp())}
    loadHistory={() => []} run={scriptedRun()} />);
  await sleep(50);
  r2.stdin.write('/new'); await sleep(40);
  r2.stdin.write(ENTER); await sleep(160);
  const p = String(got.at(-1));
  assert.match(p, /- deploy-checks: repo version/, "the create response's list is in");
  assert.match(p, /- playwright-cli: system tier, merged by the server/, 'system entries ride the same list');
  r2.unmount();
});
