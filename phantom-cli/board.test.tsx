// The BoardStore against a scripted API: adoption of server cards and stream
// records, optimistic writes and their reverts, the kanban tool's wire shape,
// and the event-stream follow policy. Nothing here renders — what the screen
// looks like is not checked, on purpose (see test/CLAUDE.md's one rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardStore, type Card, type CardStep, type Stream } from './board.js';
import { kanbanOps } from './kanban.js';
import { keyedItems } from '../core/kanban.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// `requirements` is a jsonb column, and jsonb does NOT preserve object key
// order (PostgreSQL docs 8.14) — an item written {key,text,done} comes back
// sorted by key length then bytewise. Every card the fake hands out wears
// that shape, so the editor's diff is proven blind to field order; a fake in
// the client's own order would hide a permanent "saving…" in production.
const asJsonb = (r: CardStep[]): CardStep[] => r.map((s) => ({ key: s.key, done: s.done, text: s.text }));

function makeCard(o: Partial<Card> & { id: number; seq: number; title: string; status: string }): Card {
  const card = { pos: o.seq, details: '', requirements: [],
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
        requirements?: { key?: string; text: string; done: boolean }[] };
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

test('the store follows the event stream: a write from anywhere is adopted at once, a delete drops the card, a pairing fills the Session row', async () => {
  const { api, calls } = fakeApi(seed());
  const feed = fakeStream();
  const store = new BoardStore(api, 'w1', feed.stream);
  store.follow();
  await sleep(50);
  assert.equal(feed.opens.length, 1, 'one link, opened with the store');
  const loads = () => calls.filter((c) => c.method === 'GET').length;
  const before = loads();

  // The looper renamed card 1 and moved it: the record IS the row.
  feed.emit({ event: 'card', card: makeCard({ id: 1, seq: 1, title: 'looper renamed', status: 'doing' }) });
  await sleep(30);
  assert.equal(store.bySeq(1)?.title, 'looper renamed');
  assert.equal(store.bySeq(1)?.status, 'doing', 'the card moved columns');
  // A card born elsewhere appears.
  feed.emit({ event: 'card', card: makeCard({ id: 9, seq: 9, title: 'born elsewhere', status: 'backlog' }) });
  await sleep(30);
  assert.equal(store.bySeq(9)?.title, 'born elsewhere');
  // A hard delete drops it.
  feed.emit({ event: 'deleted', id: 9 });
  await sleep(30);
  assert.equal(store.bySeq(9), undefined);
  // A loop pairing lands in the Session row.
  feed.emit({ event: 'session', card: 2, id: 'sess-2', name: null });
  await sleep(10);
  assert.deepEqual(store.state.sessions?.[2], { id: 'sess-2', name: null });
  assert.equal(loads(), before, 'events are applied, never fetched');

  store.close();
  await sleep(10);
  assert.ok(feed.opens[0].aborted, 'close hangs up');
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
  await sleep(50);

  const first = await store.create({ title: 'stream first', status: 'backlog' });
  await sleep(30);
  assert.equal(store.state.cards.filter((t) => t.id === first.id).length, 1, 'one copy in state');

  order = 'after';
  const second = await store.create({ title: 'answer first', status: 'backlog' });
  await sleep(30);
  assert.equal(store.state.cards.filter((t) => t.id === second.id).length, 1, 'one copy in state');

  store.close();
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

test('a lock event starts the turn clock once; repeats and release behave', async () => {
  const { api } = fakeApi(seed());
  const store = new BoardStore(api, 'w1');
  await store.load();

  store.applyEvent({ event: 'session_lock', card: 3, id: 's3', locked: true });
  const started = store.state.cardLocked?.[3];
  assert.ok(typeof started === 'number', 'a lock event starts the clock');
  // The lock event repeats on renewal and on reconnect. The START must survive
  // that, or an hour-old turn would look new every time its hold was renewed.
  store.applyEvent({ event: 'session_lock', card: 3, id: 's3', locked: true });
  assert.equal(store.state.cardLocked?.[3], started, 'a repeat does not restart the clock');

  // And an unlock event removes the key.
  store.applyEvent({ event: 'session_lock', card: 3, id: 's3', locked: false });
  assert.equal(store.state.cardLocked?.[3], undefined, 'unlock removes the key');
});

test('lock and git events never touch the session name the pairing announced', async () => {
  // The regression: the old one-shape-fits-all `session` event let a lock or
  // work update (which knows nothing of names) overwrite the name the loop
  // pairing had just announced — the card editor reverted to "unnamed". The
  // split makes each event complete for its own fact.
  const { api } = fakeApi(seed());
  const store = new BoardStore(api, 'w1');
  await store.load();

  store.applyEvent({ event: 'session', card: 2, id: 'sess-2', name: 'plan the thing' });
  assert.deepEqual(store.state.sessions?.[2], { id: 'sess-2', name: 'plan the thing' });

  store.applyEvent({ event: 'session_lock', card: 2, id: 'sess-2', locked: true });
  store.applyEvent({ event: 'session_work', card: 2, id: 'sess-2', work: 'not_pushed' });
  store.applyEvent({ event: 'session_lock', card: 2, id: 'sess-2', locked: false });
  assert.deepEqual(store.state.sessions?.[2], { id: 'sess-2', name: 'plan the thing' },
    'lock and work events leave the name alone');
  assert.equal(store.state.cardWork?.[2], 'not_pushed', 'the work fact still lands');
  assert.equal(store.state.cardLocked?.[2], undefined, 'the lock fact still lands');

  store.close();
});
