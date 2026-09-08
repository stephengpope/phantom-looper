// Several sessions open at once: the store that owns them. A turn streaming
// into a session nobody is looking at is exactly the case component state
// cannot express, so it is tested where it lives — state-level, no React.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelMessage, Tool } from 'ai';
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

test('/model rebuilds every UNLOCKED session, not just the one on screen', () => {
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

test('a session that has sent a message is locked — rebuildAgents skips it', async () => {
  const store = new SessionStore(scriptedRun({ text: 'reply' }));
  seed(store, 's1'); seed(store, 's2');
  // Send a message to s1 — it becomes locked (lastMessageAt > 0)
  await store.send('s1', 'hello');
  assert.ok(store.get('s1')!.lastMessageAt > 0, 'the session that spoke has lastMessageAt > 0');
  assert.equal(store.get('s2')!.lastMessageAt, 0, 'the silent session is still at 0');
  // Rebuild: s1 keeps its original model, s2 gets the new one.
  store.rebuildAgents(() => ({
    agent: { id: 'rebuilt' } as never,
    summary: { ...summary, model: 'new-model' },
  }));
  assert.equal(store.get('s1')!.summary.model, 'fake', 's1 kept its original model — locked');
  assert.equal(store.get('s2')!.summary.model, 'new-model', 's2 got the new model — unlocked');
});

test('a resumed session with history and a pin is locked from the start', () => {
  const store = new SessionStore(scriptedRun());
  store.add({
    id: 's3', branch: 'b', workspaceId: 'w',
    tools: {}, agent: { id: 'a' } as never, summary,
    transcript: transcriptFor('s3'),
    history: [{ role: 'user', content: 'old message' }],
    // A resumed session always carries its pin (the row's, or its transcript
    // header's) — history-without-pin is the duplicate's copy, tested next.
    pin: { provider: 'test', model: 'fake', baseUrl: null },
  });
  assert.ok(store.get('s3')!.lastMessageAt > 0, 'a resumed session with history is locked');
  store.rebuildAgents(() => ({
    agent: { id: 'rebuilt' } as never,
    summary: { ...summary, model: 'new-model' },
  }));
  assert.equal(store.get('s3')!.summary.model, 'fake', 'the resumed session kept its model — locked');
});

test('a duplicate\'s copy — history, NO pin — follows /model until its first NEW message', async () => {
  const store = new SessionStore(scriptedRun({ text: 'reply' }));
  store.add({
    id: 's5', branch: 'b', workspaceId: 'w',
    tools: {}, agent: { id: 'a' } as never, summary,
    transcript: transcriptFor('s5'),
    // The copy arrives with the source's conversation but no pin: its
    // messages came from the source, so they must not settle the model.
    history: [{ role: 'user', content: 'copied history' }],
    pin: null,
  });
  assert.equal(store.get('s5')!.lastMessageAt, 0, 'copied history does not settle the model');
  store.rebuildAgents(() => ({
    agent: { id: 'rebuilt' } as never,
    summary: { ...summary, model: 'new-model' },
  }));
  assert.equal(store.get('s5')!.summary.model, 'new-model', 'the copy follows /model like a fresh session');
  // Its first NEW message ends the window — exactly like a fresh session.
  await store.send('s5', 'the first new message');
  store.rebuildAgents(() => ({
    agent: { id: 'again' } as never,
    summary: { ...summary, model: 'third-model' },
  }));
  assert.equal(store.get('s5')!.summary.model, 'new-model', 'the first new message settled it');
});

test('a pinned session is skipped even before it speaks — the pin is the signal, not the clock', () => {
  const store = new SessionStore(scriptedRun());
  store.add({
    id: 's4', branch: 'b', workspaceId: 'w',
    tools: {}, agent: { id: 'a' } as never, summary,
    transcript: transcriptFor('s4'),
    // Opened with a pin but no replayed history (the transcript is on the
    // server): the pin alone must keep /model off it.
    pin: { provider: 'test', model: 'fake', baseUrl: null },
  });
  store.rebuildAgents(() => ({
    agent: { id: 'rebuilt' } as never,
    summary: { ...summary, model: 'new-model' },
  }));
  assert.equal(store.get('s4')!.summary.model, 'fake', 'the pin held');
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
