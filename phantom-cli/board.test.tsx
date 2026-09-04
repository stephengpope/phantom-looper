// The Board against a scripted API: render, mouse drag between columns,
// click → edit screen → debounced auto-save, keyboard create/archive, and the property the
// whole design hangs on — an edit made through the STORE (what the
// Assistant's kanban tool calls) repaints an open board by itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Board } from './components/Board.js';
import { BoardStore, type Card, type CardStep, type Stream } from './board.js';
import { kanbanOps } from './App.js';
import { keyedItems } from '../core/kanban.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The tui suite runs with FORCE_COLOR=3; matching is on text, not paint.
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const sgr = (code: number, x: number, y: number, release = false) =>
  `\x1b[<${code};${x + 1};${y + 1}${release ? 'm' : 'M'}`;

// `requirements` is a jsonb column, and jsonb does NOT preserve object key
// order (PostgreSQL docs 8.14) — an item written {key,text,done} comes back
// sorted by key length then bytewise. Every card the fake hands out wears
// that shape, so the editor's diff is proven blind to field order; a fake in
// the client's own order would hide a permanent "saving…" in production.
const asJsonb = (r: CardStep[]): CardStep[] => r.map((s) => ({ key: s.key, done: s.done, text: s.text }));

function makeCard(o: Partial<Card> & { id: number; seq: number; title: string; status: string }): Card {
  const card = { pos: o.seq, details: '', user_story: '', requirements: [],
    blocked_reason: null, auto_plan: null, auto_build: null, pinned: false, archived: false,
    created_at: '2026-08-23', updated_at: '2026-08-23', ...o };
  return { ...card, requirements: asJsonb(card.requirements) };
}

/** A scripted server: holds cards in memory, records every call. */
function fakeApi(cards: Card[]) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let nextId = Math.max(0, ...cards.map((t) => t.id)) + 1;
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === 'GET') {
      // The route's two read modes: ?seq= is the one-card lookup (archived
      // or not); the plain board GET excludes archived cards.
      const seq = /[?&]seq=(\d+)/.exec(path);
      if (seq) return { prefix: 'PHA', columns: ['backlog', 'doing', 'done', 'blocked'], cards: cards.filter((t) => t.seq === Number(seq[1])) };
      return { prefix: 'PHA', workspace: 'widgets', columns: ['backlog', 'doing', 'done', 'blocked'], cards: cards.filter((t) => !t.archived) };
    }
    if (method === 'POST') {
      const t = makeCard({ id: nextId, seq: nextId++, status: 'backlog', ...(body as { title: string }) });
      cards.push(t);
      return { prefix: 'PHA', columns: ['backlog', 'doing', 'done', 'blocked'], card: t };
    }
    if (method === 'PATCH') {
      const id = Number(path.split('/').pop());
      const t = cards.find((x) => x.id === id)!;
      const { items, ...rest } = body as { items?: { op: string; key?: string; text?: string; done?: boolean }[];
        requirements?: { key?: string; text: string; done?: boolean }[] };
      // The REAL server keys every keyless item of a whole-list replace
      // (routes/kanban.ts → keyedItems). A fake that skipped this was kinder
      // than the server and hid a permanent "saving…" in the card editor.
      if (rest.requirements) rest.requirements = asJsonb(keyedItems(rest.requirements));
      Object.assign(t, rest);
      for (const o of items ?? []) {
        if (o.op === 'add') t.requirements = [...t.requirements, { key: `srv${t.requirements.length}`, text: o.text ?? '', done: o.done ?? false }];
        else if (o.op === 'remove') t.requirements = t.requirements.filter((e) => e.key !== o.key);
        else t.requirements = t.requirements.map((e) => e.key !== o.key ? e
          : { ...e, ...(o.text !== undefined && o.op === 'edit' ? { text: o.text } : {}), ...(o.done !== undefined ? { done: o.done } : {}) });
      }
      return { prefix: 'PHA', columns: ['backlog', 'doing', 'done'], card: t };
    }
    return {};
  };
  return { api, calls };
}

const seed = () => [
  makeCard({ id: 1, seq: 1, title: 'first card', status: 'backlog',
    requirements: [{ key: 'a', text: 'a', done: true }, { key: 'b', text: 'b', done: false }] }),
  makeCard({ id: 2, seq: 2, title: 'second card', status: 'backlog' }),
  makeCard({ id: 3, seq: 3, title: 'busy card', status: 'doing' }),
  makeCard({ id: 4, seq: 4, title: 'stuck card', status: 'blocked', blocked_reason: 'stuck' }),
];

function mount(store: BoardStore) {
  return render(<Board store={store} width={100} height={24} isActive onClose={() => {}} />);
}

test('renders columns, numbers and titles from the store', async () => {
  const { api } = fakeApi(seed());
  const r = mount(new BoardStore(api, 'w1'));
  await sleep(50);
  const f = strip(r.lastFrame()!);
  assert.match(f, /backlog \(2\)/);
  assert.match(f, /doing \(1\)/);
  assert.match(f, /1-first card/);
  assert.match(f, /PHA · widgets/, 'the header names the prefix and workspace');
  assert.match(f, /3-busy card/);
  r.unmount();
});

test('mouse drag moves a card to another column and PATCHes status+pos', async () => {
  const { api, calls } = fakeApi(seed());
  const store = new BoardStore(api, 'w1');
  const r = mount(store);
  await sleep(50);
  const lines = strip(r.lastFrame()!).split('\n');
  const y1 = lines.findIndex((l) => l.includes('first card'));
  const x1 = lines[y1].indexOf('first card');
  const y2 = lines.findIndex((l) => l.includes('busy card'));
  const x2 = lines[y2].indexOf('busy card');
  r.stdin.write(sgr(0, x1, y1)); await sleep(20);
  r.stdin.write(sgr(32, x2, y2)); await sleep(20);
  assert.match(strip(r.lastFrame()!), /moving #1 → doing/);
  r.stdin.write(sgr(0, x2, y2, true)); await sleep(30);
  assert.equal(store.state.cards.find((t) => t.id === 1)!.status, 'doing');
  const patch = calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/cards/1'));
  assert.ok(patch, 'a PATCH went to the server');
  assert.equal((patch!.body as { status: string }).status, 'doing');
  r.unmount();
});

test('click opens the edit screen; edits auto-save after the debounce; esc flushes and closes', async () => {
  const { api, calls } = fakeApi(seed());
  const r = mount(new BoardStore(api, 'w1'));
  await sleep(50);
  const lines = strip(r.lastFrame()!).split('\n');
  const y = lines.findIndex((l) => l.includes('second card'));
  const x = lines[y].indexOf('second card');
  r.stdin.write(sgr(0, x, y)); await sleep(20);
  r.stdin.write(sgr(0, x, y, true)); await sleep(30);
  assert.match(strip(r.lastFrame()!), /PHA-2/);
  assert.ok(!strip(r.lastFrame()!).includes('Save'), 'no Save button — edits auto-save');
  r.stdin.write(' v2'); await sleep(20);
  assert.match(strip(r.lastFrame()!), /saving…/, 'the header says a save is pending');
  assert.ok(!calls.some((c) => c.method === 'PATCH'), 'the debounce holds the PATCH');
  await sleep(800); // past the 600ms debounce
  const patch = calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/cards/2'));
  assert.ok(patch, 'the pause flushed one PATCH');
  assert.equal((patch!.body as { title: string }).title, 'second card v2');
  assert.match(strip(r.lastFrame()!), /saved ✓/);
  // esc flushes what the debounce still holds, then closes — nothing is lost
  r.stdin.write('X'); await sleep(20);
  r.stdin.write('\x1b'); await sleep(30);
  const flushed = calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/cards/2')).pop();
  assert.equal((flushed!.body as { title: string }).title, 'second card v2X');
  assert.match(strip(r.lastFrame()!), /second card v2X/, 'back on the columns, the edit kept');
  r.unmount();
});

// The auto-save loop this pins: a requirement typed in the editor used to go
// out keyless, come back wearing a server-minted key, and read as an unsaved
// change FOREVER — one PATCH per debounce for as long as the card was open,
// the corner stuck on "saving…". The PATCH COUNT is the assertion; the label
// alone would pass on a fix that still hammered the server.
test('a new requirement saves ONCE and the corner settles on saved', async () => {
  const { api, calls } = fakeApi(seed());
  const r = mount(new BoardStore(api, 'w1'));
  await sleep(50);
  const lines = strip(r.lastFrame()!).split('\n');
  const y = lines.findIndex((l) => l.includes('second card'));
  const x = lines[y].indexOf('second card');
  r.stdin.write(sgr(0, x, y)); await sleep(20);
  r.stdin.write(sgr(0, x, y, true)); await sleep(30);
  // one tab per write: a single chunk of three is one key event, not three
  for (let i = 0; i < 3; i++) { r.stdin.write('\t'); await sleep(20); }  // Title → Story → Details → Requires
  r.stdin.write('it works'); await sleep(20);
  const patches = () => calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/cards/2'));
  await sleep(800);                                  // past the 600ms debounce
  assert.equal(patches().length, 1, 'the pause sent exactly one PATCH');
  assert.deepEqual((patches()[0].body as { requirements: { text: string }[] }).requirements.map((s) => s.text),
    ['it works']);
  assert.match(strip(r.lastFrame()!), /saved ✓/, 'the corner says the save landed');
  await sleep(1400);                                 // two more debounce windows
  assert.equal(patches().length, 1, 'and it stays at one — no re-arm on the answer');
  assert.match(strip(r.lastFrame()!), /saved ✓/);
  assert.ok(!strip(r.lastFrame()!).includes('saving…'), 'nothing is still in flight');
  r.unmount();
});

test('a save the server does not take stops at one PATCH and says so', async () => {
  const cards = [makeCard({ id: 1, seq: 1, title: 'card', status: 'backlog' })];
  const bodies: unknown[] = [];
  const api = async (method: string, _path: string, body?: unknown) => {
    if (method === 'GET') return { prefix: 'PHA', columns: ['backlog', 'doing'], cards };
    if (method === 'PATCH') {
      bodies.push(body);
      // A server that answers 200 and silently drops a field — the shape of
      // any future client/server mismatch.
      const rest = { ...(body as Record<string, unknown>) };
      delete rest.user_story;
      Object.assign(cards[0], rest);
      return { prefix: 'PHA', columns: ['backlog', 'doing'], card: { ...cards[0] } };
    }
    return {};
  };
  const r = mount(new BoardStore(api, 'w1'));
  await sleep(50);
  const lines = strip(r.lastFrame()!).split('\n');
  const y = lines.findIndex((l) => l.includes('1-card'));   // not the header's "1 card"
  const x = lines[y].indexOf('1-card');
  r.stdin.write(sgr(0, x, y)); await sleep(20);
  r.stdin.write(sgr(0, x, y, true)); await sleep(30);
  assert.match(strip(r.lastFrame()!), /PHA-1/, 'the editor is open');
  r.stdin.write('\t'); await sleep(30);               // Title → Story
  r.stdin.write('as a builder'); await sleep(20);
  await sleep(2000);                                  // three debounce windows
  assert.equal(bodies.length, 1, 'the patch that did not land is never re-sent by itself');
  assert.match(strip(r.lastFrame()!), /save failed — edit to retry/,
    'the corner tells the truth: the change is not on the server');
  r.unmount();
});

test('tab / shift+tab move the focused card right / left, focus following', async () => {
  const { api, calls } = fakeApi(seed());
  const store = new BoardStore(api, 'w1');
  const r = mount(store);
  await sleep(50);
  r.stdin.write('\t'); await sleep(30); // first card: backlog → doing
  assert.equal(store.state.cards.find((t) => t.id === 1)!.status, 'doing');
  const patch = calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/cards/1'));
  assert.equal((patch!.body as { status: string }).status, 'doing', 'tab PATCHes the card one column right');
  // shift+tab moves the SAME card back — proof the focus followed it over
  r.stdin.write('\x1b[Z'); await sleep(30);
  assert.equal(store.state.cards.find((t) => t.id === 1)!.status, 'backlog');
  // at the board's left edge, shift+tab is a no-op (never a rightward move)
  const patches = calls.filter((c) => c.method === 'PATCH').length;
  r.stdin.write('\x1b[Z'); await sleep(30);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, patches, 'no PATCH at the edge');
  r.unmount();
});

test('n creates in the focused column; a archives', async () => {
  const { api, calls } = fakeApi(seed());
  const store = new BoardStore(api, 'w1');
  const r = mount(store);
  await sleep(50);
  r.stdin.write('n'); await sleep(20);
  r.stdin.write('brand new'); await sleep(20);
  r.stdin.write('\r'); await sleep(30);
  assert.ok(calls.some((c) => c.method === 'POST'));
  assert.match(strip(r.lastFrame()!), /brand new/);
  r.stdin.write('a'); await sleep(30); // archives the focused (first) card
  const patch = calls.find((c) => c.method === 'PATCH' && (c.body as { archived?: boolean }).archived);
  assert.ok(patch, 'archive is a PATCH, not a delete');
  assert.ok(!strip(r.lastFrame()!).includes('first card'));
  r.unmount();
});

test('the board fetch excludes the archive; fetchCard adopts one by seq and a refresh keeps it', async () => {
  const cards = [...seed(),
    makeCard({ id: 5, seq: 5, title: 'old card', status: 'done', archived: true, updated_at: '2026-08-30T10:00:00Z' })];
  const { api, calls } = fakeApi(cards);
  const store = new BoardStore(api, 'w1');
  await store.load();
  assert.equal(calls[0].path, '/workspaces/w1/cards', 'the board GET carries no archive');
  assert.equal(store.bySeq(5), undefined, 'an archived card is not in the store');
  const t = await store.fetchCard(5);
  assert.equal(t?.title, 'old card');
  assert.ok(calls.some((c) => c.path === '/workspaces/w1/cards?seq=5'), 'a miss asks the server by seq');
  assert.deepEqual(store.cardsIn('done').map((x) => x.seq), [], 'the adopted card stays off the columns');
  await store.load(); // the reconnect reload must not drop it — an open editor would close
  assert.equal(store.bySeq(5)?.title, 'old card', 'an adopted archived card survives a refresh');
});

test('v hands off to /archived (the App owns the menu); archived cards stay off the board', async () => {
  const cards = [...seed(),
    makeCard({ id: 5, seq: 5, title: 'old card', status: 'done', archived: true, updated_at: '2026-08-30T10:00:00Z' })];
  const { api } = fakeApi(cards);
  const store = new BoardStore(api, 'w1');
  let opened = 0;
  // 140 wide: the footer fits one row here (it wraps below ~106 cells).
  const r = render(<Board store={store} width={140} height={24} isActive
    onClose={() => {}} onArchived={() => { opened++; }} />);
  await sleep(50);
  assert.ok(!strip(r.lastFrame()!).includes('old card'), 'archived cards are not on the board');
  assert.match(strip(r.lastFrame()!), /\[v\]iew archived/, 'the footer offers the key');
  r.stdin.write('v'); await sleep(20);
  assert.equal(opened, 1);
  r.unmount();
});

test('the footer shows the arrows bare, no brackets', async () => {
  const { api } = fakeApi(seed());
  const store = new BoardStore(api, 'w1');
  // 140 wide: the footer fits one row here (it wraps below ~106 cells).
  const r = render(<Board store={store} width={140} height={24} isActive onClose={() => {}} />);
  await sleep(50);
  // The selection hint shows the keys themselves — one space apart, no
  // brackets: shorter than the word, and it reads as the key it names.
  const footer = strip(r.lastFrame()!);
  assert.match(footer, /↑ ↓ ← →  \[enter\]/, 'the arrows open the footer, bare, two spaces between items');
  assert.ok(!/\[arrows\]|\[↑\]|\[↓\]/.test(footer), 'no brackets around the arrows');
  // Both move keys are live (tab right, shift+tab left) and both are named in
  // full: `s+tab` was shorthand for a key no keyboard calls that.
  assert.match(footer, /\[tab\/shift\+tab\] move/, 'the move hint names shift+tab in full');
  r.unmount();
});

test('p toggles pin on the focused card, both ways', async () => {
  const { api, calls } = fakeApi(seed());
  const store = new BoardStore(api, 'w1');
  const r = mount(store);
  await sleep(50);
  r.stdin.write('p'); await sleep(30);
  const on = calls.find((c) => c.method === 'PATCH' && (c.body as { pinned?: boolean }).pinned === true);
  assert.ok(on, 'p PATCHes pinned: true on the focused card');
  assert.match(strip(r.lastFrame()!), /• 1-first card/, 'the pinned card shows the gutter mark');
  r.stdin.write('p'); await sleep(30);
  const off = calls.find((c) => c.method === 'PATCH' && (c.body as { pinned?: boolean }).pinned === false);
  assert.ok(off, 'p again PATCHes pinned: false');
  r.unmount();
});

test('e expands the focused column to the full width — a long title reads whole; e/esc collapse; ← → walk the expanded view', async () => {
  // 100 cols over four columns leaves ~22 cells per column: this title cannot
  // fit there and must once the column has the whole width.
  const long = 'a title long enough that four narrow columns cut it off';
  const cards = [...seed(), makeCard({ id: 5, seq: 5, title: long, status: 'backlog' })];
  const { api } = fakeApi(cards);
  const store = new BoardStore(api, 'w1');
  const r = mount(store);
  await sleep(50);
  let f = strip(r.lastFrame()!);
  assert.ok(!f.includes(long), 'setup: the narrow column truncates the title');
  assert.match(f, /\[e\]xpand/, 'the footer offers the key');
  r.stdin.write('e'); await sleep(30);
  f = strip(r.lastFrame()!);
  assert.match(f, /backlog \(3\)/, 'the focused column is up');
  assert.ok(!f.includes('doing ('), 'the other columns are gone');
  assert.ok(!f.includes('done ('));
  assert.ok(f.includes(long), 'the title reads in full across the width');
  assert.match(f, /\[e\] collapse/, 'the footer names the way back');
  // → while expanded walks to the next column, still expanded
  r.stdin.write('\x1b[C'); await sleep(30);
  f = strip(r.lastFrame()!);
  assert.match(f, /doing \(1\)/, 'the next column is now the expanded one');
  assert.ok(!f.includes('backlog ('), 'and backlog left the screen');
  // esc is one level back: expanded → all columns, NOT chat
  let closed = 0;
  r.rerender(<Board store={store} width={100} height={24} isActive onClose={() => { closed++; }} />);
  r.stdin.write('\x1b'); await sleep(30);
  f = strip(r.lastFrame()!);
  assert.match(f, /backlog \(3\)/); assert.match(f, /doing \(1\)/);
  assert.equal(closed, 0, 'esc collapsed the column; the board stayed');
  r.stdin.write('e'); await sleep(30);
  assert.match(strip(r.lastFrame()!), /\[e\] collapse/, 'e expands again');
  r.stdin.write('e'); await sleep(30);
  assert.match(strip(r.lastFrame()!), /\[e\]xpand/, 'e a second time collapses — a toggle');
  r.unmount();
});

test('a store request (the Assistant\'s "expand plan") expands that column; "board" collapses it', async () => {
  const { api } = fakeApi(seed());
  const store = new BoardStore(api, 'w1');
  const r = mount(store);
  await sleep(50);
  // Two frames (the request lands, the Board consumes it) — Ink throttles
  // frames at ~32ms, so wait past the second one.
  store.requestColumn('doing'); await sleep(80);
  let f = strip(r.lastFrame()!);
  assert.match(f, /doing \(1\)/, 'the asked-for column is up');
  assert.ok(!f.includes('backlog ('), 'alone');
  assert.match(f, /\[e\] collapse/);
  store.requestBoard(); await sleep(80);
  f = strip(r.lastFrame()!);
  assert.match(f, /backlog \(2\)/); assert.match(f, /doing \(1\)/);
  assert.match(f, /\[e\]xpand/, 'every column is back');
  r.unmount();
});

test('a store edit from outside the UI (the kanban tool path) repaints the open board', async () => {
  const { api } = fakeApi(seed());
  const store = new BoardStore(api, 'w1');
  const r = mount(store);
  await sleep(50);
  assert.ok(!strip(r.lastFrame()!).includes('renamed by voice'));
  await store.update(2, { title: 'renamed by voice', status: 'done' }); // what the tool handler calls
  await sleep(30);
  const f = strip(r.lastFrame()!);
  assert.match(f, /renamed by voice/);
  assert.match(f, /done \(1\)/);
  r.unmount();
});

test('a store edit while a card is OPEN rebases the edit screen live, keeping the field mid-edit', async () => {
  const { api } = fakeApi(seed());
  const store = new BoardStore(api, 'w1');
  const r = mount(store);
  await sleep(50);
  const lines = strip(r.lastFrame()!).split('\n');
  const y = lines.findIndex((l) => l.includes('second card'));
  const x = lines[y].indexOf('second card');
  r.stdin.write(sgr(0, x, y)); await sleep(20);
  r.stdin.write(sgr(0, x, y, true)); await sleep(30);
  r.stdin.write(' v2'); await sleep(20); // the user is mid-edit on Title
  await store.update(2, { user_story: 'as a voice user', details: 'said aloud' }); // the kanban tool path
  await sleep(30);
  const f = strip(r.lastFrame()!);
  assert.match(f, /as a voice user/, 'the outside edit shows without reopening');
  assert.match(f, /said aloud/);
  assert.match(f, /second card v2/, 'the title mid-edit keeps the user text');
  r.unmount();
});

test('kanbanOps: a spoken column name ("in progress") resolves; an unknown one is an error naming the real columns', async () => {
  const cards = [makeCard({ id: 1, seq: 1, title: 'card', status: 'done' })];
  const columns = ['backlog', 'in_progress', 'done'];
  const api = async (method: string, _path: string, body?: unknown) => {
    if (method === 'GET') return { prefix: 'PHA', columns, cards };
    if (method === 'PATCH') {
      const b = body as { status?: string };
      if (b.status && !columns.includes(b.status)) throw new Error(`status must be one of: ${columns.join(', ')}`);
      Object.assign(cards[0], body);
      return { card: cards[0] };
    }
    return {};
  };
  const store = new BoardStore(api, 'w1');
  const moved = await kanbanOps(store, { action: 'move', card: 1, status: 'in progress' }) as { ok?: boolean; status?: string };
  assert.equal(moved.ok, true);
  assert.equal(moved.status, 'in_progress', 'the spoken name resolved to the real column');
  const bad = await kanbanOps(store, { action: 'move', card: 1, status: 'doing' }) as { error?: string };
  assert.match(bad.error!, /backlog, in_progress, done/, 'the error teaches the agent the columns');
  assert.equal(cards[0].status, 'in_progress', 'the bad move never reached the server');
});

test('kanbanOps: a server reject comes back as an error and the board reverts — never ok with the old status', async () => {
  const cards = [makeCard({ id: 1, seq: 1, title: 'card', status: 'done' })];
  const api = async (method: string) => {
    if (method === 'GET') return { prefix: 'PHA', columns: ['backlog', 'done'], cards };
    if (method === 'PATCH') throw new Error('boom');
    return {};
  };
  const store = new BoardStore(api, 'w1');
  const res = await kanbanOps(store, { action: 'move', card: 1, status: 'backlog' }) as { ok?: boolean; error?: string };
  assert.equal(res.ok, undefined);
  assert.match(res.error!, /boom/);
  assert.equal(store.state.cards[0].status, 'done', 'the optimistic move reverted');
});

test('kanbanOps: item ops go over the wire by key — add/edit/remove/tick touch only the named items', async () => {
  const cards = seed();
  cards[0].requirements = [{ key: 'a', text: 'a', done: true }, { key: 'b', text: 'b', done: false }];
  const { api, calls } = fakeApi(cards);
  const store = new BoardStore(api, 'w1');
  const res = await kanbanOps(store, { action: 'items', card: 1, ops: [
    { op: 'tick', key: 'b', done: true },
    { op: 'edit', key: 'a', text: 'a reworded' },
    { op: 'add', text: 'c' },
  ] }) as { ok?: boolean; requirements?: { key: string; text: string; done: boolean }[] };
  assert.equal(res.ok, true);
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.deepEqual((patch?.body as { items: unknown[] }).items.length, 3,
    'the wire carries ops by key — the list itself is never resent');
  assert.deepEqual(res.requirements, [
    { key: 'a', text: 'a reworded', done: true },
    { key: 'b', text: 'b', done: true },
    { key: 'srv2', text: 'c', done: false } ],
    'the result hands every key back, the added item\'s server-assigned key included');
  const removed = await kanbanOps(store, { action: 'items', card: 1,
    ops: [{ op: 'remove', key: 'srv2' }] }) as { requirements?: unknown[] };
  assert.deepEqual(removed.requirements?.length, 2, 'remove deletes exactly the named item');
  const none = await kanbanOps(store, { action: 'items', card: 1 }) as { error?: string };
  assert.match(none.error!, /items needs ops/);
});

test('kanbanOps: history reads a card\'s revisions off the server — a deleted card, not on the board, included', async () => {
  const revs = [{ op: 'delete', changed: { title: 'gone card', status: 'review' }, changed_at: '2026-08-25' }];
  const paths: string[] = [];
  const api = async (method: string, path: string) => {
    paths.push(path);
    if (path.includes('/revisions')) return { card: 9, revisions: revs };
    return { prefix: 'PHA', columns: ['backlog'], cards: [] };
  };
  const store = new BoardStore(api, 'w1');
  const res = await kanbanOps(store, { action: 'history', card: 9, limit: 5 });
  assert.deepEqual(res, { card: 9, revisions: revs }, 'card 9 exists nowhere on the board — history still answers');
  assert.ok(paths.some((p) => p === '/workspaces/w1/revisions?card=9&limit=5'));
  const none = await kanbanOps(store, { action: 'history' }) as { error?: string };
  assert.match(none.error!, /card number/);
});

test('the edit page shows every field, hides Blocked until it applies, and toggles Archived', async () => {
  const { api, calls } = fakeApi(seed());
  const r = mount(new BoardStore(api, 'w1'));
  await sleep(50);
  const lines = strip(r.lastFrame()!).split('\n');
  const y = lines.findIndex((l) => l.includes('second card'));
  const x = lines[y].indexOf('second card');
  r.stdin.write(sgr(0, x, y)); await sleep(20);
  r.stdin.write(sgr(0, x, y, true)); await sleep(30);
  let f = strip(r.lastFrame()!);
  for (const label of ['Title', 'Story', 'Details', 'Requires', 'Archived'])
    assert.match(f, new RegExp(label), `${label} is visible on an empty card`);
  assert.ok(!f.includes('Blocked'), 'Blocked hidden while it does not apply');
  // Toggle archived — the debounce flushes it without any Save.
  const rows = f.split('\n');
  const ay = rows.findIndex((l) => l.includes('Archived'));
  const ax = rows[ay].indexOf('Archived');
  r.stdin.write(sgr(0, ax, ay)); await sleep(20);        // click focuses AND toggles
  f = strip(r.lastFrame()!);
  assert.match(f, /yes — off the board/);
  await sleep(800); // past the 600ms debounce
  const patch = calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/cards/2'));
  assert.equal((patch!.body as { archived: boolean }).archived, true);
  r.stdin.write('\x1b'); await sleep(30);                // esc back to the columns
  // Blocked follows the STATUS: a card in the blocked column shows the row.
  const lines2 = strip(r.lastFrame()!).split('\n');
  const by = lines2.findIndex((l) => l.includes('stuck card'));
  const bx = lines2[by].indexOf('stuck card');
  r.stdin.write(sgr(0, bx, by)); await sleep(20);
  r.stdin.write(sgr(0, bx, by, true)); await sleep(30);
  f = strip(r.lastFrame()!);
  assert.match(f, /Blocked/);
  assert.match(f, /stuck/);
  r.unmount();
});

test('auto plan / auto build: each per-card switch cycles inherit → on → off and rides a PATCH', async () => {
  const { cycleAuto, autoLabel } = await import('./components/CardEditor.js');
  assert.equal(cycleAuto(null), true);
  assert.equal(cycleAuto(true), false);
  assert.equal(cycleAuto(false), null);

  // A row ALWAYS answers "will the looper run this?" — the real value
  // first, where it came from after. Inherit never hides the answer.
  assert.equal(autoLabel(true, false), 'on · this card');
  assert.equal(autoLabel(false, true), 'off · this card');
  assert.equal(autoLabel(null, true, 'workspace'), 'on · workspace');
  assert.equal(autoLabel(null, false, 'global'), 'off · global');
  assert.equal(autoLabel(null, false, 'default'), 'off · default');

  const { api, calls } = fakeApi([makeCard({ id: 1, seq: 1, title: 'x', status: 'backlog' })]);
  const store = new BoardStore(api as never, 'w1');
  await store.load();
  assert.equal(await store.update(1, { auto_plan: true }), null);
  assert.deepEqual(calls.find((c) => c.method === 'PATCH')?.body, { auto_plan: true },
    'each switch is an ordinary card field on the wire');
  assert.equal(await store.update(1, { auto_build: false }), null);
  assert.deepEqual(calls.filter((c) => c.method === 'PATCH').at(-1)?.body, { auto_build: false },
    'the other switch rides its own PATCH, untouched by the first');
});

test('pinned: the group sits at the top of its column, pos still sorts inside each group', async () => {
  const { api, calls } = fakeApi([
    makeCard({ id: 1, seq: 1, title: 'first', status: 'backlog' }),
    makeCard({ id: 2, seq: 2, title: 'second', status: 'backlog' }),
    makeCard({ id: 3, seq: 3, title: 'third', status: 'backlog', pinned: true }),
    makeCard({ id: 4, seq: 4, title: 'fourth', status: 'backlog', pinned: true }),
  ]);
  const store = new BoardStore(api as never, 'w1');
  await store.load();
  // pos is seq here: the pinned pair (3, 4) leads in its own pos order, the
  // unpinned pair follows in its.
  assert.deepEqual(store.cardsIn('backlog').map((t) => t.seq), [3, 4, 1, 2]);
  // The pin rides a PATCH like any card field.
  assert.equal(await store.update(1, { pinned: true }), null);
  assert.deepEqual(calls.filter((c) => c.method === 'PATCH').at(-1)?.body, { pinned: true });
  assert.deepEqual(store.cardsIn('backlog').map((t) => t.seq), [1, 3, 4, 2],
    'the newly pinned card joins the group at its own pos rank');

  // On the board a pinned row carries • in the left gutter; unpinned rows
  // keep the two blank cells.
  const r = mount(store);
  await sleep(50);
  const f = strip(r.lastFrame()!);
  assert.match(f, /• 1-first/);
  assert.match(f, /• 3-third/);
  assert.match(f, / {2}2-second/, 'unpinned rows keep the blank gutter');
  r.unmount();
});

test('the Session row names the card\'s coding session and a click opens it; no loop reads none', async () => {
  // card_sessions rides the board GET — the fake serves one for card 1 only.
  const { api } = fakeApi(seed());
  const withSessions = async (method: string, path: string, body?: unknown) => {
    const d = await api(method, path, body) as Record<string, unknown>;
    if (method === 'GET') return { ...d, card_sessions: [{ card: 1, id: 'sess-1', name: 'wiring the tasks screen' }] };
    return d;
  };
  const opened: string[] = [];
  const r = render(<Board store={new BoardStore(withSessions, 'w1')} width={100} height={30}
    isActive onClose={() => {}} onOpenSession={(id) => opened.push(id)} />);
  await sleep(50);

  // Card 1 has a loop: the row names its coding session.
  let lines = strip(r.lastFrame()!).split('\n');
  let y = lines.findIndex((l) => l.includes('first card'));
  let x = lines[y].indexOf('first card');
  r.stdin.write(sgr(0, x, y)); await sleep(20);
  r.stdin.write(sgr(0, x, y, true)); await sleep(30);
  let f = strip(r.lastFrame()!);
  assert.match(f, /Session/);
  assert.match(f, /wiring the tasks screen/);

  // The loop block reads cause before effect: both switches, THEN the session
  // they produced — and Pinned/Archived still close the page.
  const order = (label: string) => strip(r.lastFrame()!).split('\n').findIndex((l) => l.includes(label));
  assert.ok(order('Auto plan') < order('Session'), 'Session sits below Auto plan');
  assert.ok(order('Auto build') < order('Session'), 'Session sits below Auto build');
  assert.ok(order('Session') < order('Pinned'), 'Session stays above Pinned/Archived');

  // Clicking the row opens the session.
  lines = f.split('\n');
  y = lines.findIndex((l) => l.includes('wiring the tasks screen'));
  x = lines[y].indexOf('wiring');
  r.stdin.write(sgr(0, x, y)); await sleep(30);
  assert.deepEqual(opened, ['sess-1']);

  // Focus walks the same order the page shows: shift+tab off Session lands on
  // Auto build (the click above left focus on Session).
  r.stdin.write('\x1b[Z'); await sleep(30);
  assert.match(strip(r.lastFrame()!), /❯ Auto build/);

  // Card 2 never entered the loop: the row still shows, and says so.
  r.stdin.write('\x1b'); await sleep(30);
  lines = strip(r.lastFrame()!).split('\n');
  y = lines.findIndex((l) => l.includes('second card'));
  x = lines[y].indexOf('second card');
  r.stdin.write(sgr(0, x, y)); await sleep(20);
  r.stdin.write(sgr(0, x, y, true)); await sleep(30);
  f = strip(r.lastFrame()!);
  assert.match(f, /none — appears when the looper runs the card/);
  r.unmount();
});

// ── the event stream ──────────────────────────────────────────────────────
// The server's /events feed, scripted: `emit` pushes a record down the open
// link, `end` hangs up (the store must reconnect), `opens` counts links.
function fakeStream() {
  const opens: AbortSignal[] = [];
  let push: ((rec: Record<string, unknown> | null) => void) | null = null;
  const stream: Stream = async (_path, signal) => {
    opens.push(signal);
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
  return { stream, opens, emit: (rec: Record<string, unknown>) => push?.(rec), end: () => push?.(null) };
}

test('the store follows the event stream: a write from anywhere repaints the board at once, a delete drops the card, a pairing fills the Session row', async () => {
  const { api, calls } = fakeApi(seed());
  const feed = fakeStream();
  const store = new BoardStore(api, 'w1', feed.stream);
  store.follow();
  const r = mount(store);
  await sleep(50);
  assert.equal(feed.opens.length, 1, 'one link, opened with the store');
  assert.match(strip(r.lastFrame()!), /1-first card/);
  const loads = () => calls.filter((c) => c.method === 'GET').length;
  const before = loads();

  // The looper renamed card 1 and moved it: the record IS the row.
  feed.emit({ event: 'card', card: makeCard({ id: 1, seq: 1, title: 'looper renamed', status: 'doing' }) });
  await sleep(30);
  let f = strip(r.lastFrame()!);
  assert.match(f, /1-looper renamed/);
  assert.match(f, /doing \(2\)/, 'the card moved columns');
  // A card born elsewhere appears.
  feed.emit({ event: 'card', card: makeCard({ id: 9, seq: 9, title: 'born elsewhere', status: 'backlog' }) });
  await sleep(30);
  assert.match(strip(r.lastFrame()!), /9-born elsewhere/);
  // A hard delete drops it.
  feed.emit({ event: 'deleted', id: 9 });
  await sleep(30);
  assert.doesNotMatch(strip(r.lastFrame()!), /born elsewhere/);
  // A loop pairing lands in the Session row.
  feed.emit({ event: 'session', card: 2, id: 'sess-2', name: null });
  await sleep(10);
  assert.deepEqual(store.state.sessions?.[2], { id: 'sess-2', name: null });
  assert.equal(loads(), before, 'events are applied, never fetched');

  store.close();
  await sleep(10);
  assert.ok(feed.opens[0].aborted, 'close hangs up');
  r.unmount();
});

test('a created card lands once: the stream announces it before the POST answers (the server\'s order) and after', async () => {
  // The real route publishes {event: card} on the stream BEFORE it builds
  // its reply, so the row reaches the store twice — once down the link, once
  // as the POST's answer. A fake that answered without publishing hid a
  // duplicate card on the board.
  const { api: plain } = fakeApi(seed());
  const feed = fakeStream();
  let order: 'before' | 'after' = 'before';
  const api = async (method: string, path: string, body?: unknown) => {
    if (method !== 'POST') return plain(method, path, body);
    const d = await plain(method, path, body) as { card: Card };
    if (order === 'before') { feed.emit({ event: 'card', card: { ...d.card } }); await sleep(5); }
    else setTimeout(() => feed.emit({ event: 'card', card: { ...d.card } }), 5);
    return d;
  };
  const store = new BoardStore(api, 'w1', feed.stream);
  store.follow();
  const r = mount(store);
  await sleep(50);

  const first = await store.create({ title: 'stream first', status: 'backlog' });
  await sleep(30);
  assert.equal(store.state.cards.filter((t) => t.id === first.id).length, 1, 'one copy in state');
  let f = strip(r.lastFrame()!);
  assert.equal(f.match(/stream first/g)?.length, 1, 'one row on the board');
  assert.match(f, /backlog \(3\)/);

  order = 'after';
  const second = await store.create({ title: 'answer first', status: 'backlog' });
  await sleep(30);
  assert.equal(store.state.cards.filter((t) => t.id === second.id).length, 1, 'one copy in state');
  f = strip(r.lastFrame()!);
  assert.equal(f.match(/answer first/g)?.length, 1, 'one row on the board');
  assert.match(f, /backlog \(4\)/);

  store.close();
  r.unmount();
});

test('a dropped stream is reopened and the board reloaded once to fill the gap', async () => {
  const { api, calls } = fakeApi(seed());
  const feed = fakeStream();
  const store = new BoardStore(api, 'w1', feed.stream);
  store.follow();
  await sleep(20);
  await store.load();
  const loads = () => calls.filter((c) => c.method === 'GET').length;
  const before = loads();
  feed.end();
  await sleep(1200); // the first retry is 1 s out
  assert.equal(feed.opens.length, 2, 'reconnected');
  assert.equal(loads(), before + 1, 'one reload after the reconnect');
  store.close();
});

test('no stream wired: follow is a no-op and the store still loads', async () => {
  const { api } = fakeApi(seed());
  const store = new BoardStore(api, 'w1');
  store.follow();
  await store.load();
  assert.equal(store.bySeq(1)?.title, 'first card');
  store.close();
});
