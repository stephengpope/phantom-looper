// Kanban: workspace-scoped cards in the workspace schema, written only through
// /workspaces/:id/cards. Real Postgres, no Docker, no git — the board is pure
// DB + routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testDb } from './harness.js';
import { makePaths } from '../phantom-backend/pool/paths.js';
import { buildApp } from '../phantom-backend/api/app.js';
import { defaultPrefix } from '../phantom-backend/api/routes/kanban.js';

let db: Awaited<ReturnType<typeof testDb>>['db'];
let pgPool: Awaited<ReturnType<typeof testDb>>['pool'];
let app: Awaited<ReturnType<typeof buildApp>>;
let root: string;
let wsId: string;
let schema: string;

before(async () => {
  ({ db, pool: pgPool } = await testDb('kanban'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-kanban-'));
  app = await buildApp({
    db, paths: makePaths(path.join(root, 'workspaces')), apiKey: 'test-key',
    encryptionKey: Buffer.alloc(32, 9), version: 'test', pgPool,
  });
  const r = await app.inject({ method: 'POST', url: '/workspaces', headers: H,
    payload: { url: 'https://github.com/acme/widgets.git' } });
  assert.equal(r.statusCode, 201, r.body);
  wsId = json(r).data.id;
  schema = json(r).data.schemaName;
});

after(async () => {
  await app?.close();
  await pgPool?.end();
  await fs.rm(root, { recursive: true, force: true });
});

const H = { authorization: 'Bearer test-key' };
const json = (r: { body: string }) => JSON.parse(r.body);

test('defaultPrefix: first three letters, letters only, uppercased', () => {
  assert.equal(defaultPrefix('phantom-looper'), 'PHA');
  assert.equal(defaultPrefix('x9-y'), 'XY');
  assert.equal(defaultPrefix('...'), 'TSK');
});

test('empty board: code-default columns and repo-derived prefix', async () => {
  const r = await app.inject({ method: 'GET', url: `/workspaces/${wsId}/cards`, headers: H });
  assert.equal(r.statusCode, 200);
  const d = json(r).data;
  assert.deepEqual(d.columns, ['backlog', 'plan', 'in_progress', 'blocked', 'done']);
  assert.equal(d.prefix, 'WID'); // widgets
  assert.deepEqual(d.cards, []);
  const missing = await app.inject({ method: 'GET', url: '/workspaces/nope/cards', headers: H });
  assert.equal(missing.statusCode, 404);
});

test('create: seq counts up, status defaults to first column, pos appends per column', async () => {
  const a = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
    payload: { title: 'first card', details: 'body', user_story: 'as a dev',
      requirements: [{ text: 'works' }, { text: 'step 1' }, { text: 'step 2', done: true }] } })).data.card;
  const b = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
    payload: { title: 'second card' } })).data.card;
  const c = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
    payload: { title: 'in progress', status: 'in_progress' } })).data.card;
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
  assert.deepEqual([a.status, b.status, c.status], ['backlog', 'backlog', 'in_progress']);
  assert.ok(a.pos < b.pos, 'appends within the column');
  assert.equal(c.pos, 1, 'each column has its own tail');
  // ajv fills the schema default (done always present); the server assigns
  // each requirement a permanent random id as its key.
  assert.deepEqual(a.requirements.map((x: { text: string; done: boolean }) => [x.text, x.done]),
    [['works', false], ['step 1', false], ['step 2', true]]);
  for (const x of a.requirements)
    assert.match(x.key, /^[a-z0-9]{4}$/, 'every item carries a server-assigned id');

  const bad = await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
    payload: { title: 'x', status: 'nope' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(json(bad).error.code, 'invalid_args');
});

test('patch: edit, move, block, archive; archived cards leave the board but not the table', async () => {
  const board = json(await app.inject({ method: 'GET', url: `/workspaces/${wsId}/cards`, headers: H })).data;
  const [first] = board.cards;

  const edited = json(await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${first.id}`, headers: H,
    payload: { title: 'renamed', status: 'done', pos: 0.5, blocked_reason: 'waiting on review' } })).data.card;
  assert.equal(edited.title, 'renamed');
  assert.equal(edited.status, 'done');
  assert.equal(edited.blocked_reason, 'waiting on review');
  assert.notEqual(edited.updated_at, first.updated_at);

  const unblocked = json(await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${first.id}`, headers: H,
    payload: { blocked_reason: null, archived: true } })).data.card;
  assert.equal(unblocked.blocked_reason, null);

  const after = json(await app.inject({ method: 'GET', url: `/workspaces/${wsId}/cards`, headers: H })).data;
  assert.ok(!after.cards.some((t: { id: number }) => t.id === first.id), 'archived card off the board');
  const withArchived = json(await app.inject({ method: 'GET', url: `/workspaces/${wsId}/cards?archived=true`, headers: H })).data;
  assert.ok(withArchived.cards.some((t: { id: number }) => t.id === first.id), 'still in the table');

  // The looper's per-card switches ride the same routes: null = inherit,
  // true/false = explicit, each round-trips like any field — independently.
  assert.equal(first.auto_plan, null, 'a new card inherits the workspace defaults');
  assert.equal(first.auto_build, null);
  const armed = json(await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${first.id}`, headers: H,
    payload: { auto_plan: true } })).data.card;
  assert.equal(armed.auto_plan, true);
  assert.equal(armed.auto_build, null, 'the other switch is untouched');
  const built = json(await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${first.id}`, headers: H,
    payload: { auto_build: false } })).data.card;
  assert.equal(built.auto_build, false);
  assert.equal(built.auto_plan, true);

  // resolution — the human's reply to a block — rides the same one field list.
  const resolved = json(await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${first.id}`, headers: H,
    payload: { resolution: 'use approach B, the key is set now' } })).data.card;
  assert.equal(resolved.resolution, 'use approach B, the key is set now');
  const clearedRes = json(await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${first.id}`, headers: H,
    payload: { resolution: null } })).data.card;
  assert.equal(clearedRes.resolution, null, 'null clears it');

  // And CREATE must honor it too — it silently dropped the switch once, so a
  // card born armed landed unarmed and "did nothing".
  const born = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
    payload: { title: 'born armed', status: 'plan', auto_plan: true, auto_build: true } })).data.card;
  assert.equal(born.auto_plan, true, 'a card created with a switch on IS armed');
  assert.equal(born.auto_build, true);

  const badMove = await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${first.id}`, headers: H,
    payload: { status: 'nope' } });
  assert.equal(badMove.statusCode, 400);
  const empty = await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${first.id}`, headers: H, payload: {} });
  assert.equal(empty.statusCode, 400);
});

test('archived=only pages the archive newest first; seq looks up one card, archived or not', async () => {
  // Three more archived cards, archived in order — their updated_at ascends
  // (ties fall to id desc, same result: c, b, a).
  const mk = async (title: string) => json(await app.inject({ method: 'POST',
    url: `/workspaces/${wsId}/cards`, headers: H, payload: { title } })).data.card;
  const a = await mk('arch a'); const b = await mk('arch b'); const c = await mk('arch c');
  for (const t of [a, b, c])
    assert.equal((await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${t.id}`, headers: H,
      payload: { archived: true } })).statusCode, 200);
  const ids = (d: { cards: { id: number }[] }) => d.cards.map((t) => t.id);

  const all = json(await app.inject({ method: 'GET',
    url: `/workspaces/${wsId}/cards?archived=only`, headers: H })).data;
  assert.ok(all.cards.every((t: { archived: boolean }) => t.archived), 'the listing is archived cards only');
  assert.ok(!('card_sessions' in all), 'the listing skips the board extras');
  assert.equal(all.total, all.cards.length, 'total = the whole archive');
  assert.deepEqual(ids(all).filter((id) => [a.id, b.id, c.id].includes(id)), [c.id, b.id, a.id],
    'newest change first');

  // Keyset walk at limit 2: the pages concatenate to the full listing,
  // nothing repeated, nothing skipped; a short page is the end.
  const got: number[] = [];
  let cursor = '';
  for (;;) {
    const d = json(await app.inject({ method: 'GET',
      url: `/workspaces/${wsId}/cards?archived=only&limit=2${cursor}`, headers: H })).data;
    got.push(...ids(d));
    assert.equal(d.total, all.total, 'every page knows how long the archive is');
    if (d.cards.length < 2) break;
    const tail = d.cards[d.cards.length - 1];
    cursor = `&before=${encodeURIComponent(tail.updated_at)}&before_id=${tail.id}`;
  }
  assert.deepEqual(got, ids(all), 'the pages walk the listing exactly once, in order');

  const one = json(await app.inject({ method: 'GET',
    url: `/workspaces/${wsId}/cards?seq=${a.seq}`, headers: H })).data;
  assert.deepEqual(ids(one), [a.id], 'seq returns the one card, archived included');
  assert.equal(one.cards[0].archived, true);
  const none = json(await app.inject({ method: 'GET',
    url: `/workspaces/${wsId}/cards?seq=9999`, headers: H })).data;
  assert.deepEqual(none.cards, [], 'an unknown number is an empty list, not an error');
});

test('checklist keys: random ids assigned by the server, distinct, preserved through a replace', async () => {
  const t = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
    payload: { title: 'keyed', requirements: [
      { text: 'Write the failing test!' }, { text: 'write the failing test' }, { text: '' } ] } })).data.card;
  const keys = t.requirements.map((x: { key: string }) => x.key);
  for (const k of keys) assert.match(k, /^[a-z0-9]{4}$/);
  assert.equal(new Set(keys).size, 3, 'every item gets its own id, duplicate texts included');

  // A replace keeps the keys it is handed (reword + reorder), assigns to new items.
  const [k1, k2] = keys;
  const replaced = json(await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${t.id}`, headers: H,
    payload: { requirements: [
      { key: k2, text: 'reworded entirely', done: true },
      { key: k1, text: 'Write the failing test!' },
      { text: 'a new step' } ] } })).data.card;
  assert.deepEqual(replaced.requirements.slice(0, 2), [
    { key: k2, text: 'reworded entirely', done: true },
    { key: k1, text: 'Write the failing test!', done: false } ],
    'identity rides the key, not the text or the position');
  assert.match(replaced.requirements[2].key, /^[a-z0-9]{4}$/, 'the new item got a fresh id');
  assert.ok(!keys.includes(replaced.requirements[2].key));

  // A key echoed back cased ("K7F2" for k7f2) stores as the same id — never a
  // second identity for the same item.
  const recased = json(await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${t.id}`, headers: H,
    payload: { requirements: [{ key: k1.toUpperCase(), text: 'still the first item', done: true }] } })).data.card;
  assert.deepEqual(recased.requirements, [{ key: k1, text: 'still the first item', done: true }]);
});

test('item ops: add/edit/remove/tick by key touch nothing else; bad keys and ops+replace are refused whole', async () => {
  const t = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
    payload: { title: 'tickable',
      requirements: [{ text: 'step one' }, { text: 'step two' }, { text: 'step three' }] } })).data.card;
  // Keys are COPIED from the create response — the whole design: results carry
  // them so the agent never derives one from the text.
  const [ka, kb, kc] = t.requirements.map((x: { key: string }) => x.key);

  // One call, ops in order: tick, reword, add.
  const r1 = json(await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${t.id}`, headers: H,
    payload: { items: [
      { op: 'tick', key: kb, done: true },
      { op: 'edit', key: ka, text: 'step one, reworded' },
      { op: 'add', text: 'step four' } ] } })).data.card;
  assert.deepEqual(r1.requirements.map((x: { key: string; text: string; done: boolean }) => [x.key, x.text, x.done]), [
    [ka, 'step one, reworded', false], [kb, 'step two', true], [kc, 'step three', false],
    [r1.requirements[3].key, 'step four', false] ], 'each op touched exactly its item; add landed at the end');
  assert.match(r1.requirements[3].key, /^[a-z0-9]{4}$/, 'the added item got a server id, in the result');

  // remove deletes exactly the named item; a cased key echo still lands.
  const r2 = json(await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${t.id}`, headers: H,
    payload: { items: [
      { op: 'remove', key: r1.requirements[3].key },
      { op: 'tick', key: kb.toUpperCase(), done: false } ] } })).data.card;
  assert.deepEqual(r2.requirements.map((x: { key: string; done: boolean }) => [x.key, x.done]),
    [[ka, false], [kb, false], [kc, false]], 'remove took only its item; the cased tick landed');

  // Ops combine with plain fields in one PATCH.
  const both = json(await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${t.id}`, headers: H,
    payload: { status: 'plan', items: [{ op: 'tick', key: kb, done: true }] } })).data.card;
  assert.equal(both.status, 'plan');
  assert.equal(both.requirements[1].done, true);

  // An unknown key refuses the WHOLE call (nothing half-applied) and names the real keys.
  const bad = await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${t.id}`, headers: H,
    payload: { items: [{ op: 'tick', key: kb, done: false }, { op: 'remove', key: 'nope' }] } });
  assert.equal(bad.statusCode, 400);
  assert.match(json(bad).error.message, new RegExp(`no "nope" in requirements — the keys: ${ka}, ${kb}, ${kc}`));
  const unchanged = json(await app.inject({ method: 'GET', url: `/workspaces/${wsId}/cards`, headers: H }))
    .data.cards.find((x: { id: number }) => x.id === t.id);
  assert.equal(unchanged.requirements[1].done, true, 'the valid op in the refused call did not land');

  // A malformed op is named plainly.
  const noText = await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${t.id}`, headers: H,
    payload: { items: [{ op: 'add' }] } });
  assert.equal(noText.statusCode, 400);
  assert.match(json(noText).error.message, /add needs text/);

  // Item ops and replacing the list in one call is ambiguous — refused.
  const mixed = await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${t.id}`, headers: H,
    payload: { requirements: [{ text: 'x' }], items: [{ op: 'tick', key: ka, done: true }] } });
  assert.equal(mixed.statusCode, 400);
  assert.match(json(mixed).error.message, /not both/);

  const gone = await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/999999`, headers: H,
    payload: { items: [{ op: 'tick', key: ka, done: true }] } });
  assert.equal(gone.statusCode, 404);
});

test('the board payload always carries both resolved looper defaults and their layers', async () => {
  let d = json(await app.inject({ method: 'GET', url: `/workspaces/${wsId}/cards`, headers: H })).data;
  assert.equal(d.auto_plan_default, false);
  assert.equal(d.auto_plan_source, 'default');
  assert.equal(d.auto_build_default, false);
  assert.equal(d.auto_build_source, 'default');
  // Turn ONE on at the workspace layer: the payload says the value AND the
  // layer — which is what lets the card editor answer instead of saying
  // "inherit" — and the other switch does not move.
  await app.inject({ method: 'PATCH', url: `/settings?workspace=${wsId}`, headers: H,
    payload: { auto_plan: true } });
  d = json(await app.inject({ method: 'GET', url: `/workspaces/${wsId}/cards`, headers: H })).data;
  assert.equal(d.auto_plan_default, true);
  assert.equal(d.auto_plan_source, 'workspace');
  assert.equal(d.auto_build_default, false);
  assert.equal(d.auto_build_source, 'default');
  await app.inject({ method: 'PATCH', url: `/settings?workspace=${wsId}`, headers: H,
    payload: { auto_plan: null } });
});

test('pinned: an ordinary card field, and the board lists the pinned group first (pos inside each group)', async () => {
  const mk = async (payload: Record<string, unknown>) =>
    json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H, payload })).data.card;
  const pa = await mk({ title: 'pin a', status: 'backlog' });
  const pb = await mk({ title: 'pin b', status: 'backlog' });
  const pc = await mk({ title: 'pin c', status: 'backlog', pinned: true });
  assert.equal(pa.pinned, false, 'unpinned by default');
  assert.equal(pc.pinned, true, 'create honors the pin — same one field list');

  const order = async () => {
    const d = json(await app.inject({ method: 'GET', url: `/workspaces/${wsId}/cards`, headers: H })).data;
    const seqs = [pa.seq, pb.seq, pc.seq];
    return (d.cards as { seq: number }[]).map((c) => c.seq).filter((s) => seqs.includes(s));
  };
  // pc was created LAST (highest pos) but pinned: it leads its column.
  assert.deepEqual(await order(), [pc.seq, pa.seq, pb.seq]);
  // Pin pb too: the group grows and pos still sorts inside it (pb before pc).
  const pinned = json(await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${pb.id}`, headers: H,
    payload: { pinned: true } })).data.card;
  assert.equal(pinned.pinned, true);
  assert.deepEqual(await order(), [pb.seq, pc.seq, pa.seq]);
  // Unpin drops the card back into the column's normal order.
  await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${pb.id}`, headers: H,
    payload: { pinned: false } });
  assert.deepEqual(await order(), [pc.seq, pa.seq, pb.seq]);
});

test('card_prefix: workspace field, editable, null reverts to derived', async () => {
  await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}`, headers: H, payload: { card_prefix: 'WGT' } });
  let d = json(await app.inject({ method: 'GET', url: `/workspaces/${wsId}/cards`, headers: H })).data;
  assert.equal(d.prefix, 'WGT');
  await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}`, headers: H, payload: { card_prefix: null } });
  d = json(await app.inject({ method: 'GET', url: `/workspaces/${wsId}/cards`, headers: H })).data;
  assert.equal(d.prefix, 'WID');
});

test('delete: gone for real; seq never reused', async () => {
  const t = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
    payload: { title: 'doomed' } })).data.card;
  const del = await app.inject({ method: 'DELETE', url: `/workspaces/${wsId}/cards/${t.id}`, headers: H });
  assert.equal(json(del).data.deleted, true);
  const again = await app.inject({ method: 'DELETE', url: `/workspaces/${wsId}/cards/${t.id}`, headers: H });
  assert.equal(again.statusCode, 404);
  const next = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
    payload: { title: 'after delete' } })).data.card;
  assert.ok(next.seq > t.seq, 'sequence moves forward only');
});

test('revisions: the trigger records old values of changed keys, SQL writes included; delete keeps the whole card', async () => {
  const t = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
    payload: { title: 'audited', details: 'v1' } })).data.card;

  await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${t.id}`, headers: H,
    payload: { title: 'renamed', details: 'v2' } });
  // Same value again: updated_at moves but nothing changed — no revision.
  await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${t.id}`, headers: H,
    payload: { title: 'renamed' } });

  // A write straight over SQL — the trigger records it the same as a route
  // write, so no write path can dodge the audit trail.
  await pgPool.query(`update "${schema}".cards set details = 'v3' where id = $1`, [t.id]);

  await app.inject({ method: 'DELETE', url: `/workspaces/${wsId}/cards/${t.id}`, headers: H });

  const r = await app.inject({ method: 'GET', url: `/workspaces/${wsId}/revisions?card=${t.seq}`, headers: H });
  assert.equal(r.statusCode, 200);
  const revs = json(r).data.revisions;
  assert.deepEqual(revs.map((x: { op: string }) => x.op), ['delete', 'update', 'update'], 'newest first');
  assert.equal(revs[0].changed.title, 'renamed', 'delete holds the whole card as it last stood');
  assert.equal(revs[0].changed.details, 'v3');
  assert.equal(revs[0].changed.seq, t.seq);
  assert.deepEqual(revs[1].changed, { details: 'v2' }, 'only the keys that changed, old values');
  assert.deepEqual(revs[2].changed, { title: 'audited', details: 'v1' });

  const one = json(await app.inject({ method: 'GET', url: `/workspaces/${wsId}/revisions?card=${t.seq}&limit=1`, headers: H })).data;
  assert.equal(one.revisions.length, 1);
});

// ── auto-push on archive ─────────────────────────────────────────────────────────
// Archiving a card auto-pushes its session's work when the setting says so; the
// push itself is faked (phase4 tests the real one) — what is under test is
// the TRIGGER: who pushes, when, and what a failure does to the card.

test('archive auto-pushes the stamped session when auto_push_on_archive is on; failure un-archives into blocked', async () => {
  const { newId } = await import('../core/ids.js');
  const { sessions, folders, loops } = await import('../phantom-backend/db/schema.js');
  const pushed: string[] = [];
  let pushResult: { result: string; reason?: string } = { result: 'pushed' };
  const pushApp = await buildApp({
    db, paths: makePaths(path.join(root, 'ws2')), apiKey: 'test-key',
    encryptionKey: Buffer.alloc(32, 9), version: 'test', pgPool,
    autoPush: async (session) => { pushed.push(session.id); return pushResult as never; },
  });
  const w = json(await pushApp.inject({ method: 'POST', url: '/workspaces', headers: H,
    payload: { url: 'https://github.com/acme/pusher.git' } })).data;
  await pushApp.inject({ method: 'PATCH', url: `/settings?workspace=${w.id}`, headers: H,
    payload: { auto_push_on_archive: true } });

  const mk = async (status = 'done') => json(await pushApp.inject({ method: 'POST', url: `/workspaces/${w.id}/cards`,
    headers: H, payload: { title: 'done work', status } })).data.card;
  const patch = (id: number, payload: unknown) => pushApp.inject({
    method: 'PATCH', url: `/workspaces/${w.id}/cards/${id}`, headers: H, payload });
  const cardRow = async (seq: number) => {
    const r = json(await pushApp.inject({ method: 'GET', url: `/workspaces/${w.id}/cards?archived=true`, headers: H })).data;
    return r.cards.find((c: { seq: number }) => c.seq === seq);
  };
  const until = async (pred: () => Promise<boolean>) => {
    for (let i = 0; i < 50; i++) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 100)); }
    return false;
  };

  // No stamped session: archiving is just archiving — nothing pushes.
  const lone = await mk();
  assert.equal((await patch(lone.id, { archived: true })).statusCode, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(pushed, [], 'a card with no session has nothing to push');
  assert.equal((await cardRow(lone.seq)).archived, true);

  // A stamped session pushes. (The stamp is the loop path's; tests write the
  // row directly.)
  const carded = await mk();
  const sid = newId();
  await db.insert(folders).values({ id: sid, workspaceId: w.id, branch: `agent/${sid}`, claimSha: 'cafe' });
  await db.insert(sessions).values({
    id: sid, workspaceId: w.id, status: 'active', agent: 'coding', folderId: sid,
  });
  await db.insert(loops).values({ id: newId(), workspaceId: w.id, card: carded.seq,
    codingSessionId: sid, supervisorSessionId: sid });
  assert.equal((await patch(carded.id, { archived: true })).statusCode, 200);
  assert.ok(await until(async () => pushed.includes(sid)), 'the stamped session pushes');
  assert.equal((await cardRow(carded.seq)).archived, true, 'a successful auto-push leaves the card archived');

  // Re-saving an already archived card must not re-fire.
  pushed.length = 0;
  assert.equal((await patch(carded.id, { archived: true, title: 'renamed' })).statusCode, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(pushed, [], 'only the false -> true transition pushes');

  // Failure: the card comes back un-archived, blocked, with the reason.
  pushResult = { result: 'blocked', reason: 'merge conflict left unresolved' };
  const failing = await mk();
  const sid2 = newId();
  await db.insert(folders).values({ id: sid2, workspaceId: w.id, branch: `agent/${sid2}`, claimSha: 'cafe' });
  await db.insert(sessions).values({
    id: sid2, workspaceId: w.id, status: 'active', agent: 'coding', folderId: sid2,
  });
  await db.insert(loops).values({ id: newId(), workspaceId: w.id, card: failing.seq,
    codingSessionId: sid2, supervisorSessionId: sid2 });
  assert.equal((await patch(failing.id, { archived: true })).statusCode, 200);
  assert.ok(await until(async () => (await cardRow(failing.seq))?.status === 'blocked'),
    'a failed auto-push surfaces on the board');
  const after = await cardRow(failing.seq);
  assert.equal(after.archived, false, 'archived = complete: a failed auto-push is not archived');
  assert.match(after.blocked_reason, /merge conflict left unresolved/);

  // Archiving a card that is NOT done never pushes — that is the discard
  // gesture: it just disappears, whatever the setting says.
  const discarded = await mk('in_progress');
  const sidD = newId();
  await db.insert(folders).values({ id: sidD, workspaceId: w.id, branch: `agent/${sidD}`, claimSha: 'cafe' });
  await db.insert(sessions).values({
    id: sidD, workspaceId: w.id, status: 'active', agent: 'coding', folderId: sidD,
  });
  await db.insert(loops).values({ id: newId(), workspaceId: w.id, card: discarded.seq,
    codingSessionId: sidD, supervisorSessionId: sidD });
  pushed.length = 0;
  assert.equal((await patch(discarded.id, { archived: true })).statusCode, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(pushed, [], 'only done + archived pushes');
  assert.equal((await cardRow(discarded.seq)).archived, true, 'the discard stands');

  // The default is off: a fresh workspace archives without pushing.
  await pushApp.inject({ method: 'DELETE', url: `/settings/auto_push_on_archive?workspace=${w.id}`, headers: H });
  pushed.length = 0;
  const quiet = await mk();
  const sid3 = newId();
  await db.insert(folders).values({ id: sid3, workspaceId: w.id, branch: `agent/${sid3}`, claimSha: 'cafe' });
  await db.insert(sessions).values({
    id: sid3, workspaceId: w.id, status: 'active', agent: 'coding', folderId: sid3,
  });
  await db.insert(loops).values({ id: newId(), workspaceId: w.id, card: quiet.seq,
    codingSessionId: sid3, supervisorSessionId: sid3 });
  assert.equal((await patch(quiet.id, { archived: true })).statusCode, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(pushed, [], 'auto_push_on_archive defaults to off');

  await pushApp.close();
});

// ── card_sessions ────────────────────────────────────────────────────────────────
// The board GET names each card's CURRENT loop's coding session (newest loop
// row — the same ordering currentLoop uses), so the card editor can show and
// open it. Cards that never entered the loop are simply absent.

test('board GET carries card_sessions: the newest loop\'s coding session, by card', async () => {
  const { newId } = await import('../core/ids.js');
  const { sessions, loops } = await import('../phantom-backend/db/schema.js');
  const card = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`,
    headers: H, payload: { title: 'looped card' } })).data.card;
  const first = newId(); const current = newId();
  await db.insert(sessions).values([
    { id: first, workspaceId: wsId, status: 'active', agent: 'coding', name: 'first run' },
    { id: current, workspaceId: wsId, status: 'active', agent: 'coding', name: 'second run' },
  ]);
  await db.insert(loops).values([
    { id: newId(), workspaceId: wsId, card: card.seq, codingSessionId: first,
      supervisorSessionId: first, createdAt: new Date(Date.now() - 60_000) },
    { id: newId(), workspaceId: wsId, card: card.seq, codingSessionId: current,
      supervisorSessionId: current },
  ]);
  const d = json(await app.inject({ method: 'GET', url: `/workspaces/${wsId}/cards`, headers: H })).data;
  const hit = d.card_sessions.find((s: { card: number }) => s.card === card.seq);
  assert.deepEqual(hit, { card: card.seq, id: current, name: 'second run' },
    'the newest loop row wins; the session name rides along');
  assert.ok(d.card_sessions.every((s: { card: number }) => s.card === card.seq),
    'cards that never entered the loop are absent');
});

// The board's live feed. Every card write lands on these routes, so the
// stream is the one place a change from anywhere — the looper, the supervisor,
// another window — is heard the moment it happens. Over a real socket: inject
// cannot hold a stream open.
test('GET /workspaces/:id/events streams every card write as it happens, this workspace only', async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  const ac = new AbortController();
  const r = await fetch(`http://127.0.0.1:${port}/workspaces/${wsId}/events`, { headers: H, signal: ac.signal });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/x-ndjson');
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const next = async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const rec = JSON.parse(line);
        if (rec.event !== 'heartbeat') return rec;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('the stream ended');
      buf += dec.decode(value, { stream: true });
    }
  };
  try {
    const other = json(await app.inject({ method: 'POST', url: '/workspaces', headers: H,
      payload: { url: 'https://github.com/acme/other.git' } })).data.id;
    await app.inject({ method: 'POST', url: `/workspaces/${other}/cards`, headers: H, payload: { title: 'elsewhere' } });

    const created = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
      payload: { title: 'streamed card' } })).data.card;
    let ev = await next();
    assert.equal(ev.event, 'card');
    assert.equal((ev.card as { id: number; title: string }).id, created.id);
    assert.equal((ev.card as { title: string }).title, 'streamed card', 'the record is the full row; another workspace\'s write never crossed');

    await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${created.id}`, headers: H,
      payload: { title: 'renamed', items: [{ op: 'add', text: 'a step' }] } });
    ev = await next();
    assert.equal(ev.event, 'card');
    assert.equal((ev.card as { title: string }).title, 'renamed');
    assert.equal((ev.card as { requirements: { text: string }[] }).requirements[0].text, 'a step');

    await app.inject({ method: 'DELETE', url: `/workspaces/${wsId}/cards/${created.id}`, headers: H });
    ev = await next();
    assert.deepEqual(ev, { event: 'deleted', id: Number(created.id) });
  } finally {
    ac.abort();
  }
  const missing = await app.inject({ method: 'GET', url: '/workspaces/nope/events', headers: H });
  assert.equal(missing.statusCode, 404);
});
