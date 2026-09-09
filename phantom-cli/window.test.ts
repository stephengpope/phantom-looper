// The window, driven with no React at all. That is the whole point of the
// file it tests: opening, closing, switching and noting are things the
// Assistant and the boot path do while nothing is rendering. If this suite
// ever needs a component to run, the logic has leaked back into App.tsx.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowStore } from './window.js';
import { Transcript } from './session.js';
import { sessionsHandler, WorkspaceDirectory } from './assistantKit.js';
import type { Api } from './request.js';
import type { SessionsArgs } from './voice.js';

const nothing: Api = async () => ({});
const noTools = async () => ({});

test('a note with no session open lands in the window and retires the splash', () => {
  const w = new WindowStore({ api: nothing, newTools: noTools });
  assert.equal(w.splash, true, 'a window with no session opens on the splash');
  assert.equal(w.sessions.list().length, 0, 'and with no sessions');
  w.note('phantom-backend could not be reached');
  assert.equal(w.splash, false, 'a message the banner would cover retires it');
  assert.deepEqual(w.notes.map((p) => (p as { text: string }).text),
    ['phantom-backend could not be reached']);
  w.close();
});

test('subscribers hear the window without a render', () => {
  const w = new WindowStore({ api: nothing, newTools: noTools });
  let heard = 0;
  const stop = w.subscribe(() => { heard++; });
  w.note('one');
  w.setSplash(true);
  assert.ok(heard >= 2, `the view was told (${heard} times)`);
  stop();
  w.note('two');
  assert.equal(w.notes.length, 2, 'the note still landed after unsubscribing');
  w.close();
});

test('a failed open says which workspace it was, and opens nothing', async () => {
  const w = new WindowStore({
    api: async (_m, path) => { throw new Error(`no route ${path}`); },
    newTools: noTools,
  });
  w.seedWsFacts([{ id: 'w1', name: 'acme-app' }]);
  const ok = await w.openSession({ kind: 'new', workspaceId: 'w1' });
  assert.equal(ok, false);
  assert.equal(w.sessions.list().length, 0, 'nothing was seated');
  const said = (w.notes.at(-1) as { text: string }).text;
  assert.match(said, /could not start a session in acme-app/, 'the workspace by name, not its id');
  assert.match(said, /no route/, "and the server's own words");
  w.close();
});

test('session_switch navigates to CLI view from board, card and menu screens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phantom-win-'));
  const w = new WindowStore({
    api: nothing, newTools: noTools,
    initial: { sessionId: 's1', branch: 'agent/s1', workspaceId: 'w1', tools: {}, resumed: [] },
    makeAgent: () => ({ agent: {}, summary: { provider: 'test', model: 'fake', reasoning: 'none', maxSteps: 1 } }) as never,
    makeTranscript: (h) => new Transcript(h, join(dir, 'x.jsonl')),
  });
  const handler = sessionsHandler(w, nothing, 'test', new WorkspaceDirectory(nothing));
  const run = (args: SessionsArgs) => handler(args);

  // From the board view
  w.setView('board');
  assert.equal(w.view, 'board');
  let res = await run({ action: 'switch', id: 's1' }) as { ok?: boolean };
  assert.equal(res.ok, true);
  assert.equal(w.view, 'chat', 'view returned to chat from board');
  assert.equal(w.menu, null, 'menu is closed');

  // From a card editor
  w.openCard(7, 'board');
  assert.equal(typeof w.view, 'object');
  await run({ action: 'switch', id: 's1' });
  assert.equal(w.view, 'chat', 'view returned to chat from card');

  // From a menu screen
  w.setMenu('settings');
  assert.equal(w.menu, 'settings');
  await run({ action: 'switch', id: 's1' });
  assert.equal(w.view, 'chat', 'view returned to chat from settings');
  assert.equal(w.menu, null, 'menu closed after switch');

  w.close();
});

test('/close does not write a note into the next session', async () => {
  const w = new WindowStore({ api: nothing, newTools: noTools });
  // Seat two stub sessions so closing one leaves another (no API call).
  const stub = () => ({
    tools: {}, agent: {} as any, summary: {} as any,
    transcript: {} as any, history: [], done: [],
  });
  w.sessions.add({ id: 's1', branch: 'b1', workspaceId: 'w1', ...stub() });
  w.sessions.add({ id: 's2', branch: 'b2', workspaceId: 'w1', ...stub() });
  assert.equal(w.sessions.activeId, 's2', 'last added is active');
  // Close the active session via the /close command handler.
  await w.runCommand('close');
  assert.equal(w.sessions.activeId, 's1', 'switched to the other session');
  // The surviving session must have NO note parts — the close must not pollute it.
  const notes = w.sessions.get('s1')!.done.filter((p) => p.kind === 'note');
  assert.equal(notes.length, 0, 'no close note in the surviving session');
  w.close();
});

test('session_list carries the /resume row whole: branch, git status, model, tokens', async () => {
  // The fields the /resume table draws (Launcher.tsx) ride the server's
  // /sessions rows; the list passes them through so the Assistant can filter
  // by git status or branch without switching into each session.
  const rows = [
    { id: 's1', workspaceId: 'w1', branch: 'agent/s1', status: 'active',
      lastUsedAt: new Date().toISOString(), card: 7, cardStatus: 'in_progress',
      work: 'not_pushed', model: 'gpt-5', tokensOutput: 12400,
      name: 'board work', lastUserMessage: 'fix the failing board test', agent: 'coding' },
    { id: 's2', workspaceId: 'w1', branch: 'agent/s2', status: 'ended',
      lastUsedAt: new Date().toISOString(), work: 'merged', model: null, tokensOutput: null },
  ];
  const api: Api = async (_m, path) =>
    path.startsWith('/sessions') ? { sessions: rows }
      : path === '/workspaces' ? [{ id: 'w1', name: 'acme-app', cardPrefix: 'PHA' }] : {};
  const w = new WindowStore({ api: nothing, newTools: noTools });
  const handler = sessionsHandler(w, api, 'test', new WorkspaceDirectory(api));
  const res = await handler({ action: 'list' }) as { sessions: Array<Record<string, unknown>> };
  assert.equal(res.sessions.length, 2);
  const [one, two] = res.sessions;
  assert.equal(one.branch, 'agent/s1', 'the branch rides the row');
  assert.equal(one.git_status, 'not_pushed');
  assert.equal(one.model, 'gpt-5');
  assert.equal(one.tokens, 12400);
  assert.equal(one.card_status, 'in_progress');
  assert.equal(two.branch, 'agent/s2');
  assert.equal(two.git_status, 'merged');
  assert.equal(two.model, null, 'no pin is null, never an absent key');
  assert.equal(two.tokens, null);
  w.close();
});

test('one board per workspace, handed to every caller', () => {
  const w = new WindowStore({ api: nothing, newTools: noTools });
  assert.equal(w.boardFor('w1'), w.boardFor('w1'), 'the same store both times');
  assert.notEqual(w.boardFor('w1'), w.boardFor('w2'), 'one per workspace');
  w.close();
});

// ── the session feeds ─────────────────────────────────────────────────────
// One feed per OPEN session (watchSession in window.ts), scripted like the
// board's: `emit` pushes a record down the open link, `paths` records what
// was opened, `signals` lets the test see an abort.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeStream() {
  const paths: string[] = [];
  const signals: AbortSignal[] = [];
  let push: ((rec: Record<string, unknown> | null) => void) | null = null;
  const stream = async (path: string, signal: AbortSignal) => {
    paths.push(path);
    signals.push(signal);
    const queue: (Record<string, unknown> | null)[] = [];
    let wake: (() => void) | null = null;
    push = (rec) => { queue.push(rec); wake?.(); wake = null; };
    signal.addEventListener('abort', () => push?.(null));
    return (async function* () {
      for (;;) {
        while (queue.length === 0) await new Promise<void>((r) => { wake = r; });
        const rec = queue.shift()!;
        if (rec === null) return;
        yield rec;
      }
    })();
  };
  return { stream: stream as import('./follow.js').Stream, paths, signals,
    emit: (rec: Record<string, unknown>) => push?.(rec) };
}

function fedWindow(dir: string, stream: import('./follow.js').Stream) {
  return new WindowStore({
    api: nothing, newTools: noTools, stream,
    initial: { sessionId: 's1', branch: 'agent/s1', workspaceId: 'w1', tools: {}, resumed: [] },
    makeAgent: () => ({ agent: {}, summary: { provider: 'test', model: 'fake', reasoning: 'none', maxSteps: 1 } }) as never,
    makeTranscript: (h) => new Transcript(h, join(dir, 'x.jsonl')),
  });
}

test('an open session has its own feed: what happens to it elsewhere lands live, no render needed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phantom-win-'));
  const feed = fakeStream();
  const w = fedWindow(dir, feed.stream);
  await sleep(30);
  assert.deepEqual(feed.paths, ['/sessions/s1/events'], 'the session opened its pipe on seat');

  // A lock taken elsewhere — the looper starting a round on this session.
  feed.emit({ event: 'lock', locked: true, agent: 'coding', label: 'supervisor',
    expires_at: new Date(Date.now() + 60_000).toISOString() });
  await sleep(30);
  assert.equal(w.sessions.get('s1')!.held?.label, 'supervisor', 'the hold landed live');

  // A turn run elsewhere, streamed whole.
  feed.emit({ event: 'turn-start', agent: 'coding', message: 'fix the parser' });
  feed.emit({ event: 'part', part: { type: 'text-start', id: 't1' } });
  feed.emit({ event: 'part', part: { type: 'text-end', id: 't1' } });
  await sleep(30);
  assert.equal(w.sessions.get('s1')!.remoteBusy, true, 'the remote turn is observed mid-flight');
  feed.emit({ event: 'turn-end' });
  await sleep(30);
  const e = w.sessions.get('s1')!;
  assert.equal(e.remoteBusy, false, 'the turn closed');
  assert.ok(e.done.some((p) => p.kind === 'user' && (p as { text: string }).text === 'fix the parser'),
    'its user message shows in the conversation');
  w.close();
});

test('an interrupt off the feed stops this window\'s own running turn — remote esc', async () => {
  // The unified stop: double-esc in ANOTHER window (or Telegram /stop, or
  // the bare route) publishes `interrupt` on the session's feed; the window
  // actually running the turn aborts it through the same path esc takes.
  const dir = mkdtempSync(join(tmpdir(), 'phantom-win-'));
  const feed = fakeStream();
  // A turn that holds until its signal fires — the way a real turn sits in
  // the model stream.
  const holdRun = (async (_a: unknown, _m: unknown, _onParts: unknown, signal: AbortSignal) => {
    while (!signal.aborted) await sleep(10);
    return [];
  }) as never;
  const w = new WindowStore({
    api: nothing, newTools: noTools, stream: feed.stream, run: holdRun,
    initial: { sessionId: 's1', branch: 'agent/s1', workspaceId: 'w1', tools: {}, resumed: [] },
    makeAgent: () => ({ agent: {}, summary: { provider: 'test', model: 'fake', reasoning: 'none', maxSteps: 1 } }) as never,
    makeTranscript: (h) => new Transcript(h, join(dir, 'x.jsonl')),
  });
  await sleep(30);
  const turn = w.sessions.send('s1', 'work');
  await sleep(30);
  assert.equal(w.sessions.get('s1')!.busy, true, 'the turn is running here');

  feed.emit({ event: 'interrupt' });
  await turn;
  await sleep(30);
  assert.equal(w.sessions.get('s1')!.busy, false, 'the feed interrupt cut the turn');
  assert.ok(!w.sessions.get('s1')!.done.some((p) => p.kind === 'error'),
    'an interrupt is not an error — exactly the esc rule');
  w.close();
});

test('closing a session closes its feed; closing the window closes them all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phantom-win-'));
  const feed = fakeStream();
  const w = fedWindow(dir, feed.stream);
  await sleep(30);
  assert.equal(feed.signals.length, 1);

  // Closing the session drops its pipe. (The close leaves no session, so the
  // window tries to open a fresh one — the stub api refuses, as in the
  // failed-open test above; that is not what is asserted here.)
  await w.closeSession('s1');
  assert.equal(feed.signals[0].aborted, true, 'the feed died with the session');
  assert.equal(w.sessions.get('s1'), undefined, 'the session is gone');
  w.close();

  const dir2 = mkdtempSync(join(tmpdir(), 'phantom-win-'));
  const feed2 = fakeStream();
  const w2 = fedWindow(dir2, feed2.stream);
  await sleep(30);
  assert.equal(feed2.signals.length, 1);
  w2.close();
  assert.equal(feed2.signals[0].aborted, true, 'the window took the feed down with it');
});
