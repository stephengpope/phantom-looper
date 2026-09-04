// Server-side transcripts + the session lock (migration 014). Real Postgres,
// real git over a file:// origin, real HTTP routes via fastify.inject — same
// harness as integration.test.ts, no Docker needed (nothing here execs).
//
// The contract under test: SQL is the record of a session's conversation (the
// client's JSONL file, whole, in one row); one client at a time holds a
// session (x-phantom-looper-client), everyone else is refused transcript read AND
// write until release or expiry; duplicate copies the conversation into a NEW
// session and is the designed way past a holder; purge removes the session —
// row, transcript, overrides — for good.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { testDb } from './harness.js';
import { makeDb } from '../phantom-backend/db/client.js';
import { workspaces, sessions } from '../phantom-backend/db/schema.js';
import { makePaths, repoDir, type Paths } from '../phantom-backend/pool/paths.js';
import { bootCleanup } from '../phantom-backend/pool/pool.js';
import { buildApp } from '../phantom-backend/api/app.js';
import { stampAgent, agentAfterSave, LOOP_CLIENT_ID } from '../phantom-backend/sessions.js';
import { newId } from '../core/ids.js';

let db: ReturnType<typeof makeDb>['db'];
let pgPool: ReturnType<typeof makeDb>['pool'];
let app: Awaited<ReturnType<typeof buildApp>>;
let paths: Paths;
let root: string;
let originUrl: string;
let workspaceId: string;

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false',
    '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });
}

before(async () => {
  ({ db, pool: pgPool } = await testDb('transcripts'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-tr-'));
  paths = makePaths(path.join(root, 'workspaces'));
  await bootCleanup(paths);

  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['clone', '-q', bare, seed]);
  sh(seed, ['checkout', '-qb', 'main']);
  await fs.writeFile(path.join(seed, 'a.txt'), 'one\n');
  sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'first']);
  sh(seed, ['push', '-q', 'origin', 'main']);
  originUrl = `file://${bare}`;

  app = await buildApp({
    db, paths, apiKey: 'test-key', encryptionKey: Buffer.alloc(32, 9), version: 'test', pgPool,
  });

  workspaceId = newId();
  await db.insert(workspaces).values({
    id: workspaceId, url: originUrl, owner: 'local', name: 'transcripts',
    baseBranch: 'main', branchPrefix: 'agent', schemaName: `wsp_${workspaceId}`,
  });
});

after(async () => {
  await app?.close();
  await pgPool?.end();
  await fs.rm(root, { recursive: true, force: true });
});

const H = { authorization: 'Bearer test-key' };
const asClient = (c: string) => ({ ...H, 'x-phantom-looper-client': c });
const json = (r: { body: string }) => JSON.parse(r.body);

async function mkSession(): Promise<{ id: string; branch: string }> {
  const r = await app.inject({ method: 'POST', url: '/sessions', headers: H,
    payload: { workspace_id: workspaceId } });
  assert.equal(r.statusCode, 201, r.body);
  return json(r).data;
}

/** A minimal coding transcript: header line + one exchange. */
const jsonl = (sessionId: string, branch: string, lastUser = 'fix the tests') => [
  JSON.stringify({ type: 'session', agent: 'coding', provider: 'anthropic', model: 'm',
    created_at: 'now', system_prompt: 'FROZEN PROMPT', session_id: sessionId, workspace: workspaceId, branch }),
  JSON.stringify({ role: 'user', content: lastUser }),
  JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'done' }] }),
].join('\n') + '\n';

test('transcript: save + read round-trip; the list carries the last user line, never the blob', async () => {
  const s = await mkSession();
  const data = jsonl(s.id, s.branch, 'rename the widget module');

  let r = await app.inject({ method: 'GET', url: `/sessions/${s.id}/transcript`, headers: H });
  assert.equal(json(r).data.data, null, 'nothing stored yet');

  r = await app.inject({ method: 'PUT', url: `/sessions/${s.id}/transcript`, headers: H, payload: { data } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(json(r).data.saved, true);

  r = await app.inject({ method: 'GET', url: `/sessions/${s.id}/transcript`, headers: H });
  assert.equal(json(r).data.data, data, 'byte for byte what was sent');

  const list = await app.inject({ method: 'GET', url: '/sessions', headers: H });
  const row = (json(list).data.sessions as Array<Record<string, unknown>>).find((x) => x.id === s.id)!;
  assert.equal(row.lastUserMessage, 'rename the widget module', 'extracted at save, served on the list');
  assert.equal(row.locked, false);
  assert.equal(list.body.includes('FROZEN PROMPT'), false, 'the list never carries the blob');
});

test('lock: one holder; a second client may READ (watch) but is refused write and purge', async () => {
  const s = await mkSession();
  await app.inject({ method: 'PUT', url: `/sessions/${s.id}/transcript`, headers: asClient('A'),
    payload: { data: jsonl(s.id, s.branch) } });

  let r = await app.inject({ method: 'POST', url: `/sessions/${s.id}/lock`, headers: asClient('A'),
    payload: { label: 'stephens-mac' } });
  assert.equal(r.statusCode, 200, r.body);

  r = await app.inject({ method: 'POST', url: `/sessions/${s.id}/lock`, headers: asClient('B'), payload: {} });
  assert.equal(r.statusCode, 409);
  assert.equal(json(r).error.code, 'session_locked');
  assert.ok(json(r).error.message.includes('stephens-mac'), 'the refusal names the holder');

  // Reading is watching — safe while held, so allowed for anyone.
  r = await app.inject({ method: 'GET', url: `/sessions/${s.id}/transcript`, headers: asClient('B') });
  assert.equal(r.statusCode, 200, 'a held session can be READ — watching is safe');
  for (const [method, url, payload] of [
    ['PUT', `/sessions/${s.id}/transcript`, { data: 'x' }],
    ['DELETE', `/sessions/${s.id}?purge=true&force=true`, undefined],
  ] as const) {
    const refused = await app.inject({ method, url, headers: asClient('B'), payload });
    assert.equal(refused.statusCode, 409, `${method} ${url} while held`);
    assert.equal(json(refused).error.code, 'session_locked');
  }

  // The holder works normally, and the list says who holds it.
  r = await app.inject({ method: 'GET', url: `/sessions/${s.id}/transcript`, headers: asClient('A') });
  assert.equal(r.statusCode, 200);
  r = await app.inject({ method: 'PUT', url: `/sessions/${s.id}/transcript`, headers: asClient('A'),
    payload: { data: jsonl(s.id, s.branch, 'still mine') } });
  assert.equal(r.statusCode, 200);
  const list = await app.inject({ method: 'GET', url: '/sessions', headers: H });
  const row = (json(list).data.sessions as Array<Record<string, unknown>>).find((x) => x.id === s.id)!;
  assert.equal(row.locked, true);
  assert.equal(row.lockedLabel, 'stephens-mac');

  // Release: not-the-holder changes nothing, the holder frees it, B may hold.
  r = await app.inject({ method: 'DELETE', url: `/sessions/${s.id}/lock`, headers: asClient('B') });
  assert.equal(json(r).data.released, false);
  r = await app.inject({ method: 'DELETE', url: `/sessions/${s.id}/lock`, headers: asClient('A') });
  assert.equal(json(r).data.released, true);
  r = await app.inject({ method: 'POST', url: `/sessions/${s.id}/lock`, headers: asClient('B'), payload: {} });
  assert.equal(r.statusCode, 200, 'released means anyone may hold');
});

test('lock: x-phantom-looper-client is required to hold or release', async () => {
  const s = await mkSession();
  let r = await app.inject({ method: 'POST', url: `/sessions/${s.id}/lock`, headers: H, payload: {} });
  assert.equal(r.statusCode, 400);
  assert.equal(json(r).error.code, 'missing_client');
  r = await app.inject({ method: 'DELETE', url: `/sessions/${s.id}/lock`, headers: H });
  assert.equal(r.statusCode, 400);
});

test('lock: a dead client\'s hold ages out; a holder\'s save renews it', async () => {
  await app.inject({ method: 'PATCH', url: '/settings', headers: H,
    payload: { session_lock_ttl_ms: 1000 } });
  try {
    const s = await mkSession();
    let r = await app.inject({ method: 'POST', url: `/sessions/${s.id}/lock`, headers: asClient('A'), payload: {} });
    assert.equal(r.statusCode, 200);

    // Renewal: a save at 600ms slides expiry to 1600ms, so at 1200ms — past
    // the ORIGINAL expiry — the hold still stands.
    await sleep(600);
    r = await app.inject({ method: 'PUT', url: `/sessions/${s.id}/transcript`, headers: asClient('A'),
      payload: { data: jsonl(s.id, s.branch) } });
    assert.equal(r.statusCode, 200);
    await sleep(600);
    r = await app.inject({ method: 'POST', url: `/sessions/${s.id}/lock`, headers: asClient('B'), payload: {} });
    assert.equal(r.statusCode, 409, 'the save renewed the hold');

    // Expiry: nothing renews, and after the ttl the hold is no hold.
    await sleep(1100);
    r = await app.inject({ method: 'POST', url: `/sessions/${s.id}/lock`, headers: asClient('B'), payload: {} });
    assert.equal(r.statusCode, 200, 'an expired hold is free for the taking');
    await app.inject({ method: 'DELETE', url: `/sessions/${s.id}/lock`, headers: asClient('B') });
  } finally {
    await app.inject({ method: 'DELETE', url: '/settings/session_lock_ttl_ms', headers: H });
  }
});

test('duplicate: a new session, the conversation copied, the header rewritten — works past a holder', async () => {
  const src = await mkSession();
  await app.inject({ method: 'PUT', url: `/sessions/${src.id}/transcript`, headers: asClient('A'),
    payload: { data: jsonl(src.id, src.branch, 'the conversation travels') } });
  await app.inject({ method: 'POST', url: `/sessions/${src.id}/lock`, headers: asClient('A'),
    payload: { label: 'holder' } });

  // Client B cannot open src — but can copy it.
  const r = await app.inject({ method: 'POST', url: `/sessions/${src.id}/duplicate`, headers: asClient('B') });
  assert.equal(r.statusCode, 201, r.body);
  const copy = json(r).data;
  assert.notEqual(copy.id, src.id);
  assert.equal(copy.workspaceId, workspaceId);
  assert.equal(copy.copied_from, src.id);

  const t = await app.inject({ method: 'GET', url: `/sessions/${copy.id}/transcript`, headers: asClient('B') });
  const lines = (json(t).data.data as string).trim().split('\n');
  const header = JSON.parse(lines[0]);
  assert.equal(header.session_id, copy.id, 'the header names the copy');
  assert.equal(header.branch, copy.branch);
  assert.equal(header.system_prompt, 'FROZEN PROMPT', 'the frozen prompt travels');
  assert.deepEqual(JSON.parse(lines[1]), { role: 'user', content: 'the conversation travels' });

  const list = await app.inject({ method: 'GET', url: '/sessions', headers: H });
  const row = (json(list).data.sessions as Array<Record<string, unknown>>).find((x) => x.id === copy.id)!;
  assert.equal(row.lastUserMessage, 'the conversation travels', 'the list line rides the copy');

  await app.inject({ method: 'DELETE', url: `/sessions/${src.id}/lock`, headers: asClient('A') });
});

test('purge: the session leaves the server for good; plain delete still keeps the row', async () => {
  const s = await mkSession();
  await app.inject({ method: 'PUT', url: `/sessions/${s.id}/transcript`, headers: H,
    payload: { data: jsonl(s.id, s.branch) } });

  // Plain delete = destroy: files gone, the row stays resumable.
  let r = await app.inject({ method: 'DELETE', url: `/sessions/${s.id}`, headers: H });
  assert.equal(json(r).data.destroyed, s.id);
  r = await app.inject({ method: 'GET', url: `/sessions/${s.id}`, headers: H });
  assert.equal(json(r).data.status, 'destroyed', 'destroy keeps the row');

  // Purge on the destroyed row: row and transcript both gone.
  r = await app.inject({ method: 'DELETE', url: `/sessions/${s.id}?purge=true`, headers: H });
  assert.equal(json(r).data.purged, s.id);
  r = await app.inject({ method: 'GET', url: `/sessions/${s.id}`, headers: H });
  assert.equal(r.statusCode, 404, 'the session stopped existing');
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, s.id));
  assert.equal(rows.length, 0, 'the row — transcript on it — went for good');
});

test('token usage: summed from the transcript\'s usage lines on demand, cached by the stamp', async () => {
  const s = await mkSession();

  // Nothing saved yet: zeros, nothing cached.
  let r = await app.inject({ method: 'GET', url: `/sessions/${s.id}/token-usage`, headers: H });
  assert.deepEqual(json(r).data, { input: 0, output: 0, cache_read: 0, cache_write: 0, as_of: null, cached: false });

  // A transcript with two usage lines (one per model call, appended by the
  // agents through createAgent's record seam — hand-built here).
  const data = [
    JSON.stringify({ type: 'session', agent: 'coding', provider: 'anthropic', model: 'm',
      created_at: 'now', system_prompt: 'P', session_id: s.id, workspace: workspaceId, branch: s.branch }),
    JSON.stringify({ role: 'user', content: 'go' }),
    JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'step one' }] }),
    JSON.stringify({ type: 'usage', input: 100, output: 10, cache_read: 80, cache_write: 5 }),
    JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'step two' }] }),
    JSON.stringify({ type: 'usage', input: 200, output: 30, cache_read: 150, cache_write: 0 }),
  ].join('\n') + '\n';
  await app.inject({ method: 'PUT', url: `/sessions/${s.id}/transcript`, headers: H, payload: { data } });

  r = await app.inject({ method: 'GET', url: `/sessions/${s.id}/token-usage`, headers: H });
  let u = json(r).data;
  assert.equal(u.input, 300); assert.equal(u.output, 40);
  assert.equal(u.cache_read, 230); assert.equal(u.cache_write, 5);
  assert.equal(u.cached, false, 'first ask computes');
  assert.ok(u.as_of, 'stamped with the transcript stamp it was computed from');

  r = await app.inject({ method: 'GET', url: `/sessions/${s.id}/token-usage`, headers: H });
  assert.equal(json(r).data.cached, true, 'second ask serves the cache — same stamp');
  assert.equal(json(r).data.input, 300);

  // A save moves the stamp, so the cache stops matching and the next ask recomputes.
  await app.inject({ method: 'PUT', url: `/sessions/${s.id}/transcript`, headers: H,
    payload: { data: data + JSON.stringify({ type: 'usage', input: 50, output: 5, cache_read: 0, cache_write: 0 }) + '\n' } });
  r = await app.inject({ method: 'GET', url: `/sessions/${s.id}/token-usage`, headers: H });
  u = json(r).data;
  assert.equal(u.cached, false, 'moved stamp invalidated the cache');
  assert.equal(u.input, 350); assert.equal(u.output, 45);

  const list = await app.inject({ method: 'GET', url: '/sessions', headers: H });
  assert.equal(list.body.includes('"transcript"'), false, 'the list still never carries the blob');
});

test('purge refuses unpushed work without force, like delete always has', async () => {
  const s = await mkSession();
  await fs.writeFile(path.join(repoDir(paths, s.id), 'unpushed.txt'), 'work\n');

  let r = await app.inject({ method: 'DELETE', url: `/sessions/${s.id}?purge=true`, headers: H });
  assert.equal(r.statusCode, 409);
  assert.equal(json(r).error.code, 'unpushed_work');
  r = await app.inject({ method: 'GET', url: `/sessions/${s.id}`, headers: H });
  assert.equal(json(r).data.status, 'active', 'the refused purge changed nothing');

  r = await app.inject({ method: 'DELETE', url: `/sessions/${s.id}?purge=true&force=true`, headers: H });
  assert.equal(json(r).data.purged, s.id);
  r = await app.inject({ method: 'GET', url: `/sessions/${s.id}`, headers: H });
  assert.equal(r.statusCode, 404);
});

test('rename: a manual name sticks, turns the titler off, travels on duplicate; null hands it back', async () => {
  const { id } = await mkSession();
  // /rename: PATCH name marks it manual.
  const r1 = json(await app.inject({ method: 'PATCH', url: `/sessions/${id}`, headers: H,
    payload: { name: 'my deadlock hunt' } }));
  assert.equal(r1.data.name, 'my deadlock hunt');
  assert.equal(r1.data.nameManual, true);
  // Blank is refused — null is the way back to auto.
  const r2 = await app.inject({ method: 'PATCH', url: `/sessions/${id}`, headers: H,
    payload: { name: '   ' } });
  assert.equal(r2.statusCode, 400);
  // A transcript save still counts turns but never renames a manual name.
  const line = JSON.stringify({ role: 'user', content: 'hello' });
  await app.inject({ method: 'PUT', url: `/sessions/${id}/transcript`,
    headers: asClient('c1'), payload: { data: `${line}\n` } });
  const after = json(await app.inject({ method: 'GET', url: `/sessions/${id}`, headers: H })).data;
  assert.equal(after.turnCount, 1);
  assert.equal(after.name, 'my deadlock hunt');
  // The name and its manual mark travel on duplicate; the turn clock does not.
  const copy = json(await app.inject({ method: 'POST', url: `/sessions/${id}/duplicate`,
    headers: H, payload: {} })).data;
  const copyRow = json(await app.inject({ method: 'GET', url: `/sessions/${copy.id}`, headers: H })).data;
  assert.equal(copyRow.name, 'my deadlock hunt');
  assert.equal(copyRow.nameManual, true);
  assert.equal(copyRow.turnCount, 0);
  // null clears the name and the manual mark — auto-titles are back on.
  const r3 = json(await app.inject({ method: 'PATCH', url: `/sessions/${id}`, headers: H,
    payload: { name: null } }));
  assert.equal(r3.data.name, null);
  assert.equal(r3.data.nameManual, false);
});

test('who drives: a person\'s save takes the loop\'s coding seat over; the loop\'s save takes it back; the supervisor record never changes hands', async () => {
  const { id, branch } = await mkSession();
  const agentOf = async (sid: string) =>
    (await db.select({ agent: sessions.agent }).from(sessions).where(eq(sessions.id, sid)))[0].agent;
  const save = (sid: string, client: string) => app.inject({ method: 'PUT',
    url: `/sessions/${sid}/transcript`, headers: asClient(client), payload: { data: jsonl(sid, branch) } });

  // A session nobody stamped is a person's, and stays so under their saves.
  assert.equal(await agentOf(id), null);
  await save(id, 'macbook');
  assert.equal(await agentOf(id), null);

  // The loop's coder seat: stamped 'coding' the way the engine does it.
  await stampAgent(db, id, 'coding');
  // Typing into it lands as a save by the window's client id → theirs.
  await save(id, 'macbook');
  assert.equal(await agentOf(id), null, 'a person\'s turn takes the session over');
  // The list says so: the card link is the loop row's business, not this.
  const list = json(await app.inject({ method: 'GET', url: '/sessions', headers: H })).data as Array<Record<string, unknown>>;
  assert.equal(list.find((x) => x.id === id)!.agent, null);
  // The loop drives again (the card came back) → its save reclaims the seat.
  await save(id, LOOP_CLIENT_ID);
  assert.equal(await agentOf(id), 'coding', 'the loop\'s own save takes it back');
  // The /turn route saves as ITS caller, never as the loop: a person's ask.
  // (Scripted models live in looper.test.ts; here the rule alone is pinned.)
  assert.equal(agentAfterSave('coding', 'turn-a1b2c3'), null);
  assert.equal(agentAfterSave(null, LOOP_CLIENT_ID), 'coding');

  // The supervisor's record is read-only everywhere; whoever writes, it stays.
  await stampAgent(db, id, 'supervisor');
  await save(id, 'macbook');
  assert.equal(await agentOf(id), 'supervisor');
  await save(id, LOOP_CLIENT_ID);
  assert.equal(await agentOf(id), 'supervisor');
});

test('plan mode lives on the row: false at birth, PATCH flips it, a duplicate keeps planning', async () => {
  const { id } = await mkSession();
  // Every new session starts in code mode.
  const born = json(await app.inject({ method: 'GET', url: `/sessions/${id}`, headers: H })).data;
  assert.equal(born.planMode, false);
  // /plan: PATCH plan_mode is the record every window reads.
  const r1 = json(await app.inject({ method: 'PATCH', url: `/sessions/${id}`, headers: H,
    payload: { plan_mode: true } }));
  assert.equal(r1.data.planMode, true);
  // The list carries it like any other row fact — no extra read to seed a client.
  const listed = json(await app.inject({ method: 'GET', url: '/sessions', headers: H })).data.sessions
    .find((s: { id: string }) => s.id === id);
  assert.equal(listed.planMode, true);
  // A copy of a planning session is still planning — transcript or not.
  const copy = json(await app.inject({ method: 'POST', url: `/sessions/${id}/duplicate`,
    headers: H, payload: {} })).data;
  const copyRow = json(await app.inject({ method: 'GET', url: `/sessions/${copy.id}`, headers: H })).data;
  assert.equal(copyRow.planMode, true);
  // And back to code mode.
  const r2 = json(await app.inject({ method: 'PATCH', url: `/sessions/${id}`, headers: H,
    payload: { plan_mode: false } }));
  assert.equal(r2.data.planMode, false);
});

test('list pages by cursor: newest first, id breaks timestamp ties, before excludes everything seen', async () => {
  // Four sessions stamped into the FUTURE so this suite's other rows sit
  // below them: T+3h, then a T+2h tie pair (the id tiebreak's subject), T+1h.
  const a = await mkSession(); const b = await mkSession();
  const c = await mkSession(); const d = await mkSession();
  const t = (h: number) => new Date(Date.now() + h * 3_600_000);
  const tie = t(2);
  await db.update(sessions).set({ lastUsedAt: t(3) }).where(eq(sessions.id, a.id));
  await db.update(sessions).set({ lastUsedAt: tie }).where(eq(sessions.id, b.id));
  await db.update(sessions).set({ lastUsedAt: tie }).where(eq(sessions.id, c.id));
  await db.update(sessions).set({ lastUsedAt: t(1) }).where(eq(sessions.id, d.id));
  // Within the tie the higher id sorts first (id descends with the timestamp).
  const [tieHi, tieLo] = b.id > c.id ? [b, c] : [c, b];

  const page1 = json(await app.inject({ method: 'GET', url: '/sessions?limit=2', headers: H }))
    .data.sessions as Array<{ id: string; lastUsedAt: string }>;
  assert.deepEqual(page1.map((s) => s.id), [a.id, tieHi.id], 'newest, then the tie by id desc');

  // The cursor is the last row AS SERVED: its timestamp and id, straight back.
  const cur = page1[1];
  const page2 = json(await app.inject({ method: 'GET',
    url: `/sessions?limit=2&before=${encodeURIComponent(cur.lastUsedAt)}&before_id=${cur.id}`,
    headers: H })).data.sessions as Array<{ id: string; lastUsedAt: string }>;
  assert.deepEqual(page2.map((s) => s.id), [tieLo.id, d.id],
    'the tie partner is NOT skipped past the boundary, and nothing repeats');

  // Past the last of the four, none of them come back.
  const last = page2[1];
  const rest = json(await app.inject({ method: 'GET',
    url: `/sessions?limit=500&before=${encodeURIComponent(last.lastUsedAt)}&before_id=${last.id}`,
    headers: H })).data.sessions as Array<{ id: string }>;
  const mine = new Set([a.id, b.id, c.id, d.id]);
  assert.equal(rest.some((s) => mine.has(s.id)), false, 'before excludes every row already seen');
});

// What the list IS is the server's call: the filters the cli's /resume needs
// live in the query, and `total` counts exactly those rows — one WHERE for
// the page and the count, so a client's "N more" is never a guess.
test('the list filters server-side (typed, supervisor) and its total counts exactly the filtered rows', async () => {
  const typed = await mkSession();
  const blank = await mkSession();
  const seat = await mkSession();
  await app.inject({ method: 'PUT', url: `/sessions/${typed.id}/transcript`, headers: H,
    payload: { data: jsonl(typed.id, typed.branch, 'hello there') } });
  await app.inject({ method: 'PUT', url: `/sessions/${seat.id}/transcript`, headers: H,
    payload: { data: jsonl(seat.id, seat.branch, 'Plan card 1.') } });
  await db.update(sessions).set({ agent: 'supervisor' }).where(eq(sessions.id, seat.id));

  const ids = (d: { sessions: { id: string }[] }) => new Set(d.sessions.map((s) => s.id));
  const all = json(await app.inject({ method: 'GET', url: '/sessions', headers: H })).data;
  assert.ok(ids(all).has(blank.id) && ids(all).has(seat.id), 'unfiltered: everything');
  assert.equal(all.total, all.sessions.length, 'no limit: total is the list');

  const typedOnly = json(await app.inject({ method: 'GET', url: '/sessions?typed=true', headers: H })).data;
  assert.ok(ids(typedOnly).has(typed.id) && ids(typedOnly).has(seat.id));
  assert.ok(!ids(typedOnly).has(blank.id), 'typed=true drops a session nothing was typed into');
  assert.equal(typedOnly.total, typedOnly.sessions.length);

  const noSeats = json(await app.inject({ method: 'GET', url: '/sessions?typed=true&supervisor=false', headers: H })).data;
  assert.ok(ids(noSeats).has(typed.id));
  assert.ok(!ids(noSeats).has(seat.id), 'supervisor=false drops the looper\'s seat');
  assert.equal(noSeats.total, noSeats.sessions.length);

  // A PAGE carries the count of the whole filtered list, not of the page.
  const page = json(await app.inject({ method: 'GET', url: '/sessions?typed=true&supervisor=false&limit=1', headers: H })).data;
  assert.equal(page.sessions.length, 1);
  assert.equal(page.total, noSeats.total, 'the page knows how long the list is');
});

test('the list preview is capped: a pasted wall of text stores 200 chars, not the message', async () => {
  const s = await mkSession();
  const wall = 'x'.repeat(1000);
  await app.inject({ method: 'PUT', url: `/sessions/${s.id}/transcript`, headers: H,
    payload: { data: jsonl(s.id, s.branch, wall) } });
  const row = json(await app.inject({ method: 'GET', url: '/sessions', headers: H })).data.sessions
    .find((x: { id: string }) => x.id === s.id);
  assert.equal(row.lastUserMessage.length, 200, 'the preview, not the record');
});
