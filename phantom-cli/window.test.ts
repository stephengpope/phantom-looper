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

test('one board per workspace, handed to every caller', () => {
  const w = new WindowStore({ api: nothing, newTools: noTools });
  assert.equal(w.boardFor('w1'), w.boardFor('w1'), 'the same store both times');
  assert.notEqual(w.boardFor('w1'), w.boardFor('w2'), 'one per workspace');
  w.close();
});
