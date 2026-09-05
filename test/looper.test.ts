// The looper end to end, models scripted at the wire (createAgent's fetch
// seam — the same trick llm.test.ts uses): the loop is a DIALOGUE — the
// supervisor and the coding agent talk directly, the loop copying each reply
// into the other conversation — and a status TOOL call ends the run. A card
// with both auto switches on walks plan → in_progress → done against a real
// server (real Postgres, real git over a file:// origin, real routes via
// injectFetch). No card field says where the run is — the two transcripts and
// the card ARE the state, which is exactly what this pins.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { testDb, setWorkspaceSetting } from './harness.js';
import { makePaths } from '../phantom-backend/pool/paths.js';
import { bootCleanup } from '../phantom-backend/pool/pool.js';
import { buildApp, type AppCtx } from '../phantom-backend/api/app.js';
import { makeDocker } from '../phantom-backend/docker.js';
import { ContainerManager } from '../phantom-backend/workspace/container.js';
import { newId } from '../core/ids.js';
import { workspaces, sessions, loops } from '../phantom-backend/db/schema.js';
import { stampAgent } from '../phantom-backend/sessions.js';
import { LooperEngine } from '../phantom-backend/looper/engine.js';
import type { CardRow } from '../phantom-backend/looper/logic.js';
import { firstLine } from '../core/llm/prompts/supervisor/wiring.js';

let db: Awaited<ReturnType<typeof testDb>>['db'];
let pgPool: Awaited<ReturnType<typeof testDb>>['pool'];
let app: Awaited<ReturnType<typeof buildApp>>;
let ctx: AppCtx;
let root: string;
let wsId: string;
let schema: string;
let workspace: typeof workspaces.$inferSelect;

const H = { authorization: 'Bearer test-key' };
const json = (r: { body: string }) => JSON.parse(r.body);

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false',
    '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });
}

// ── the scripted model wire ─────────────────────────────────────────────────
// One fake Anthropic endpoint. Each scripted step is text, a tool call, or
// both — a tool_use answer makes the SDK execute the tool for real (the
// status tools PATCH the card through the live routes) and come back for the
// next step. The requests themselves are kept for asserting what each agent
// was actually sent.
interface Step { text?: string; tool?: { name: string; input: unknown } }
const wire: { kind: 'supervisor' | 'coding'; body: Record<string, unknown> }[] = [];
const script: { supervisor: Step[]; coding: Step[] } = { supervisor: [], coding: [] };
let toolSeq = 0;

const modelFetch: typeof fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  // Session-title calls ride the same wire (fired by every transcript save,
  // fire-and-forget) but are not part of any script: answer out of band and
  // keep them out of `wire`, or one lands as "the last coding request".
  if (JSON.stringify(body.system ?? '').includes('You name coding-agent sessions')) {
    return new Response(JSON.stringify({
      id: 'msg_t', type: 'message', role: 'assistant', model: 'scripted',
      content: [{ type: 'text', text: 'Scripted session title' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // Which seat is calling: the supervisor's kit is the only one carrying the
  // run-ending move tool — a structural fact of the loop, never prompt wording.
  const toolNames = ((body.tools as { name: string }[] | undefined) ?? []).map((t) => t.name);
  const kind = toolNames.includes('kanban_card_move') ? 'supervisor' as const : 'coding' as const;
  wire.push({ kind, body });
  const step = script[kind].shift() ?? { text: '(script ran dry)' };
  if (body.stream === true) {
    // Every server-side turn streams (agent.stream) — both seats, the turn
    // route — so the script answers in Anthropic's SSE shape, tool calls
    // included: a tool_use block rides as its own content block, exactly as
    // the live API sends it. (It once answered text only, and a scripted
    // supervisor move silently never happened.)
    const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const blocks: string[] = [];
    let index = 0;
    if (step.text) {
      blocks.push(
        ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
        ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: step.text } }),
        ev('content_block_stop', { type: 'content_block_stop', index }));
      index += 1;
    }
    if (step.tool) {
      blocks.push(
        ev('content_block_start', { type: 'content_block_start', index,
          content_block: { type: 'tool_use', id: `tu_${++toolSeq}`, name: step.tool.name, input: {} } }),
        ev('content_block_delta', { type: 'content_block_delta', index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.tool.input) } }),
        ev('content_block_stop', { type: 'content_block_stop', index }));
    }
    const sse = [
      ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant',
        model: 'claude-fable-5', content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 } } }),
      ...blocks,
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 } }),
      ev('message_stop', { type: 'message_stop' }),
    ].join('');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  const content: unknown[] = [];
  if (step.text) content.push({ type: 'text', text: step.text });
  if (step.tool) content.push({ type: 'tool_use', id: `tu_${++toolSeq}`, name: step.tool.name, input: step.tool.input });
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'scripted',
    content, stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

/** A fresh chain ledger — what runLoop mints; handed to manual runTurn
 *  calls so a test walk carries one across its turns the way a loop does. */
const ledger = () => ({ seeded: false, spent: 0, limit: null as number | null });

before(async () => {
  ({ db, pool: pgPool } = await testDb('looper'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-loop-'));
  const paths = makePaths(path.join(root, 'workspaces'));
  await bootCleanup(paths);

  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['clone', '-q', bare, seed]);
  sh(seed, ['checkout', '-qb', 'main']);
  await fs.writeFile(path.join(seed, 'a.txt'), 'one\n');
  sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'first']);
  sh(seed, ['push', '-q', 'origin', 'main']);

  // Real fs deps so GET /tools serves the kit definitions; the scripted model
  // never calls a file tool, so no container ever starts.
  const docker = makeDocker();
  const containers = new ContainerManager(docker, paths);
  await containers.bootCleanup();
  ctx = {
    db, paths, apiKey: 'test-key', encryptionKey: Buffer.alloc(32, 9), version: 'test', pgPool,
    fs: { docker, containers },
    modelFetch,
  };
  app = await buildApp(ctx);

  wsId = newId();
  schema = `wsp_${wsId}`;
  await db.insert(workspaces).values({
    id: wsId, url: `file://${bare}`, owner: 'local', name: 'fixture',
    baseBranch: 'main', branchPrefix: 'agent', schemaName: schema,
  });
  const { ensureWorkspaceSchema } = await import('../phantom-backend/db/workspaceSchema.js');
  await ensureWorkspaceSchema(pgPool, wsId, schema);
  await setWorkspaceSetting(db, wsId, 'auto_plan', true);
  await setWorkspaceSetting(db, wsId, 'auto_build', true);
  // The model config every agent builds from — the one flat store.
  const r = await app.inject({ method: 'PATCH', url: '/settings', headers: H,
    payload: { provider: 'anthropic', model: 'claude-fable-5', anthropic_api_key: 'sk-ant-api03-test' } });
  assert.equal(json(r).ok, true, r.body);
  workspace = (await db.select().from(workspaces).where(eq(workspaces.id, wsId)))[0];
});

after(async () => {
  await app?.close();
  await pgPool?.end();
  await fs.rm(root, { recursive: true, force: true });
});

async function cardRow(seq: number): Promise<CardRow> {
  const r = await pgPool.query(`select * from "${schema}".cards where seq = $1`, [seq]);
  return r.rows[0] as CardRow;
}

const transcriptOf = async (sessionId: string): Promise<string> => {
  const r = await app.inject({ method: 'GET', url: `/sessions/${sessionId}/transcript`, headers: H });
  const j = json(r);
  assert.equal(j.ok, true, r.body);
  return (j.data.data as string | null) ?? '';
};

test('a card with both switches on walks plan → in_progress → done: a dialogue, ended by the move tool', async () => {
  const engine = new LooperEngine({ db, pgPool, app, apiKey: 'test-key', modelFetch });
  const budget = ledger();

  const created = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
    payload: { title: 'add uptime', status: 'plan', user_story: 'as a dev', details: 'do it',
      requirements: [{ text: 'works' }] } })).data.card;
  const seq: number = created.seq;
  const key: string = created.requirements[0].key;

  // ── turn 1: the plan kickoff, read-only, a NEW session stamped for the card
  script.coding.push({ text: 'PLAN: change a.txt; verify by reading it back.' });
  await engine.runTurn(workspace, await cardRow(seq), budget);
  const loopRow = (await db.select().from(loops).where(eq(loops.card, seq)))[0];
  assert.ok(loopRow, 'the LOOP row names the pair — written once, the loop path the only writer');
  const srow = (await db.select().from(sessions).where(eq(sessions.id, loopRow.codingSessionId)))[0];
  assert.equal(srow.agent, 'coding');
  assert.match(await transcriptOf(srow.id), /^.*Plan card \d+\./m, 'the fixed plan kickoff went to the coding agent');
  assert.match(await transcriptOf(srow.id), /PLAN: change a\.txt/, 'and its reply is in the record');
  const openerReq = wire.find((w) => w.kind === 'coding')!;
  const toolNames = (openerReq.body.tools as { name: string }[] | undefined)?.map((t) => t.name) ?? [];
  assert.ok(toolNames.includes('read') && !toolNames.includes('write') && !toolNames.includes('bash'),
    `plan mode ran the readonly preset (got: ${toolNames.join(',')})`);
  assert.ok(toolNames.includes('kanban_card_read'), 'card read rides along');
  assert.ok(toolNames.includes('kanban_card_block'),
    "the coder's one board power rides every loop turn — plan mode included");

  // ── turn 2: the supervisor's first turn — seeds + the plan, then its
  // demand, which the loop will deliver to the coder VERBATIM
  script.supervisor.push({ text: 'Demand 1: name the verification step.' });
  await engine.runTurn(workspace, await cardRow(seq), budget);
  const supSession = (await db.select().from(sessions)
    .where(eq(sessions.id, loopRow.supervisorSessionId)))[0];
  assert.ok(supSession, 'the supervisor got its own session');
  assert.notEqual(supSession.id, srow.id, 'two sessions, two transcripts');
  assert.equal(supSession.folderId, srow.folderId, "the supervisor reads the coder's folder");
  const supT = await transcriptOf(supSession.id);
  assert.match(supT, /You are reviewing the coding agent's plan for card \d+\./,
    'the implanted plan briefing opens the conversation');
  assert.match(supT, /Its plan follows this format:/,
    "the reply's format rides the briefing — the shared block, not a quoted kickoff");
  assert.match(supT, /The card:/, 'the card rides the opening briefing');
  assert.match(supT, /PLAN: change a\.txt/, "the coder's reply arrived as its incoming message");
  assert.match(supT, /Demand 1: name the verification step\./, 'its reply is its own');
  const verifyReq = wire.find((w) => w.kind === 'supervisor')!;
  const supTools = (verifyReq.body.tools as { name: string }[]).map((t) => t.name);
  assert.ok(supTools.includes('read') && supTools.includes('kanban_card_read')
    && supTools.includes('web_search') && supTools.includes('web_fetch')
    && !supTools.includes('write') && !supTools.includes('bash'),
  'the supervisor inspects read-only — files, the card, the web; never file mutation');
  assert.ok(supTools.includes('kanban_card_move') && supTools.includes('kanban_card_items'),
    'plus its two board powers, bound to THE card');
  const moveDef = JSON.stringify((verifyReq.body.tools as { name: string }[])
    .find((t) => t.name === 'kanban_card_move'));
  assert.match(moveDef, /THIS ENDS THE RUN/, 'the vital description rides the wire');
  assert.match(moveDef, /in_progress/, 'plan column offers in_progress');
  assert.doesNotMatch(moveDef, /"done"/, 'never done while planning');

  // ── turn 3: the demand delivered to the coder verbatim, same session
  script.coding.push({ text: 'Changed: verification is reading a.txt back.' });
  await engine.runTurn(workspace, await cardRow(seq), budget);
  assert.match(await transcriptOf(srow.id), /Demand 1: name the verification step\./,
    "the supervisor's words reached the coder unchanged");

  // ── turn 4: the plan earned it — the supervisor calls the MOVE tool; the
  // card moves, the coder is never messaged
  script.supervisor.push({ tool: { name: 'kanban_card_move',
    input: { status: 'in_progress', reason: 'plan verified' } }, text: 'The plan holds.' });
  script.supervisor.push({ text: 'Approved and moved.' });   // the SDK's post-tool step
  const codingCallsBefore = wire.filter((w) => w.kind === 'coding').length;
  // The move's board event names the LOOP as writer and the status it left —
  // what the Telegram alerts key off (a person's move carries another client).
  const moves: Array<{ from?: string; client?: string }> = [];
  const unsub = ctx.events!.subscribeAll((_w, e) => { if (e.event === 'card') moves.push({ from: e.from, client: e.client }); });
  await engine.runTurn(workspace, await cardRow(seq), budget);
  unsub();
  assert.equal((await cardRow(seq)).status, 'in_progress', 'the tool moved the card');
  assert.deepEqual(moves.filter((m) => m.client === 'supervisor' && m.from === 'plan').length, 1,
    "the supervisor's move rode the wire as the loop's, from plan");
  assert.equal(wire.filter((w) => w.kind === 'coding').length, codingCallsBefore,
    'a terminal turn is silence — nothing crossed to the coding agent');

  // ── turn 5: same session — the execute kickoff (the plan is in history)
  script.coding.push({ text: 'Report: a.txt changed and verified, 1/1 green.' });
  await engine.runTurn(workspace, await cardRow(seq), budget);
  assert.ok((await transcriptOf(srow.id)).includes(firstLine.buildFromPlan(seq)),
    'kickoff 2 fired on the same session; the discriminator is the conversation itself');
  const execReq = wire.filter((w) => w.kind === 'coding').at(-1)!;
  const execTools = (execReq.body.tools as { name: string }[]).map((t) => t.name);
  assert.ok(execTools.includes('write') && execTools.includes('bash'), 'execution runs the full kit');

  // ── turn 6: the supervisor ticks what it verified and ends the run with
  // move(done) — three steps, one turn
  script.supervisor.push({ tool: { name: 'kanban_card_items',
    input: { ops: [{ op: 'tick', key, done: true }] } }, text: 'Verified a.txt myself.' });
  script.supervisor.push({ tool: { name: 'kanban_card_move',
    input: { status: 'done', reason: 'every requirement verified' } } });
  script.supervisor.push({ text: 'Done.' });
  await engine.runTurn(workspace, await cardRow(seq), budget);
  const after = await cardRow(seq);
  assert.equal(after.status, 'done', 'done is where human review happens');
  assert.deepEqual(after.requirements, [{ key, text: 'works', done: true }],
    "the tick is the SUPERVISOR's own verification, by key, through its items tool");
  const supT2 = await transcriptOf(supSession.id);
  assert.match(supT2, /You are reviewing the coding agent's work on card \d+\./,
    'phase two seeded the work briefing');
  assert.match(supT2, /Its completion report follows this format:/,
    "the report's format rides the work briefing");
  assert.equal(supT2.match(/The card:/g)?.length, 1,
    'the card never repeats — it rode the plan briefing alone');
  assert.equal((await db.select().from(sessions).where(eq(sessions.id, srow.id)))[0].lockedBy, null,
    'the lock is released between turns');

  // ── the loop is over; a PERSON types into the coder's session (the /turn
  // route, saving as its own client) — the row says it is theirs now.
  const agentOf = async () => (await db.select().from(sessions).where(eq(sessions.id, srow.id)))[0].agent;
  script.coding.push({ text: 'Sure — here is what I did.' });
  const manual = await app.inject({ method: 'POST', url: `/sessions/${srow.id}/turn`,
    headers: { ...H, 'x-phantom-looper-client': 'macbook' }, payload: { message: 'walk me through it' } });
  assert.equal(manual.statusCode, 200, manual.body);
  assert.equal(await agentOf(), null, "a person's turn takes the session over — who = manual");
  // ── the card comes back; the loop drives the same session again and says
  // so on the row at turn START (the seat is stamped before the supervisor
  // even runs), so a watching window reads `coding agent ⠹ …` and /resume
  // reads `coder` while the turn lasts.
  await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${created.id}`, headers: H,
    payload: { status: 'in_progress' } });
  script.supervisor.push({ text: 'Noted.' });
  await engine.runTurn(workspace, await cardRow(seq), budget);
  assert.equal(await agentOf(), 'coding', 'the loop took the seat back');
  await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${created.id}`, headers: H,
    payload: { status: 'done' } });
});

test('the coder blocks: its one board power ends the run; the return message carries the human back in', async () => {
  const engine = new LooperEngine({ db, pgPool, app, apiKey: 'test-key', modelFetch });
  const created = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
    payload: { title: 'second card', status: 'in_progress' } })).data.card;

  // Kickoff turn: the unplanned path, and the coder blocks mid-turn.
  script.coding.push({ tool: { name: 'kanban_card_block',
    input: { reason: 'the card assumes an API that does not exist — human call' } },
  text: 'The card cannot work as written.' });
  script.coding.push({ text: 'Blocked for a human decision.' });   // the SDK's post-tool step
  const supBefore = wire.filter((w) => w.kind === 'supervisor').length;
  await engine.runLoop(wsId, created.seq);
  const blocked = await cardRow(created.seq);
  assert.equal(blocked.status, 'blocked', "the coder's tool ended the run");
  assert.match(String(blocked.blocked_reason), /human call/, "with the coder's reason on the board");
  assert.equal(wire.filter((w) => w.kind === 'supervisor').length, supBefore,
    'the supervisor was never consulted — a terminal turn is silence');
  const loopRow = (await db.select().from(loops).where(eq(loops.card, created.seq)))[0];
  const t = await transcriptOf(loopRow.codingSessionId);
  assert.match(t, /Build card \d+\./, 'the direct kickoff');
  assert.match(t, /kanban_card_block/, "the block turn's tool call is ON the record — the whole turn saves, not the last step");
  assert.doesNotMatch(t, /[Pp]lan card/, 'no planning language on the unplanned path');

  // The human answers and sends the card back: the loop delivers the answer
  // to the CODER as the return message, then clears the block off the card.
  const r = await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${created.id}`,
    headers: H, payload: { status: 'in_progress', resolution: 'use the staging API instead' } });
  assert.equal(json(r).ok, true, r.body);
  script.coding.push({ text: 'Understood — building against staging.' });
  script.supervisor.push({ tool: { name: 'kanban_card_move',
    input: { status: 'blocked', reason: 'parked for the assertion' } } });
  script.supervisor.push({ text: 'Parked.' });
  const budget = ledger();
  await engine.runTurn(workspace, await cardRow(created.seq), budget);   // return → coder
  const t2 = await transcriptOf(loopRow.codingSessionId);
  assert.match(t2, /Card \d+ is back to you\./, 'the return message, frozen first line');
  assert.match(t2, /use the staging API instead/, "the human's answer rode along verbatim");
  const cleared = await cardRow(created.seq);
  assert.equal(cleared.blocked_reason, null, 'the block is consumed once delivered');
  assert.equal(cleared.resolution, null, 'so is the answer — nothing haunts the next block');
  await engine.runTurn(workspace, await cardRow(created.seq), budget);   // copy reply → supervisor parks it
  assert.equal((await cardRow(created.seq)).status, 'blocked', 'the dialogue resumed where it stood');
});

test('a round that FAILS blocks the card with the reason — the failure lands on the board, the loop ends', async () => {
  const created = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
    payload: { title: 'doomed card', status: 'plan' } })).data.card;
  // A model wire that only ever answers 401 — FATAL (the retry policy fails
  // auth errors at once), so the round fails instead of backing off.
  const dead: typeof fetch = async () => new Response(JSON.stringify({
    type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
  { status: 401, headers: { 'content-type': 'application/json' } });
  const engine = new LooperEngine({ db, pgPool, app, apiKey: 'test-key', modelFetch: dead });

  await engine.runLoop(wsId, created.seq);
  const after = await cardRow(created.seq);
  assert.equal(after.status, 'blocked', 'fail closed: a failed round can never spin silently');
  assert.match(String(after.blocked_reason), /looper turn failed: .*invalid x-api-key/,
    'the board says WHY — the model\'s own words, not the SDK\'s "no output generated"');
  // Blocked is not a loop column: a second poke finds nothing to run.
  await engine.runLoop(wsId, created.seq);
  assert.equal((await cardRow(created.seq)).status, 'blocked', 'nothing refires a doomed round');
});

test('one poke chains the whole dialogue: kickoff → review → delivery → the move, no second event needed', async () => {
  const created = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
    payload: { title: 'chained card', status: 'plan' } })).data.card;
  const engine = new LooperEngine({ db, pgPool, app, apiKey: 'test-key', modelFetch });

  script.coding.push({ text: 'PLAN: the chained plan.' });
  script.supervisor.push({ tool: { name: 'kanban_card_move',
    input: { status: 'in_progress', reason: 'plan approved' } } });
  script.supervisor.push({ text: 'Approved.' });
  script.coding.push({ text: 'Report: built and verified.' });
  script.supervisor.push({ tool: { name: 'kanban_card_move',
    input: { status: 'done', reason: 'verified' } } });
  script.supervisor.push({ text: 'Done.' });
  await engine.runLoop(wsId, created.seq);
  assert.equal((await cardRow(created.seq)).status, 'done',
    'plan kickoff → review → move → execute kickoff → review → move: one poke, the chain did it all');
});

test('the two switches gate their own columns: auto_plan off parks a plan card; auto_build runs it in in_progress', async () => {
  const engine = new LooperEngine({ db, pgPool, app, apiKey: 'test-key', modelFetch });
  const created = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
    payload: { title: 'build-only card', status: 'plan', auto_plan: false, auto_build: true } })).data.card;

  const codingBefore = wire.filter((w) => w.kind === 'coding').length;
  await engine.runLoop(wsId, created.seq);
  assert.equal((await cardRow(created.seq)).status, 'plan', 'auto_plan off: the looper never touches the plan column');
  assert.equal(wire.filter((w) => w.kind === 'coding').length, codingBefore, 'no round ran');
  assert.equal((await db.select().from(loops).where(eq(loops.card, created.seq))).length, 0, 'no loop row minted');

  // Moved to in_progress, auto_build arms it: the direct kickoff — no plan
  // kickoff in any history, so no planning language anywhere.
  script.coding.push({ text: 'built it' });
  script.supervisor.push({ tool: { name: 'kanban_card_move',
    input: { status: 'blocked', reason: 'parked for the assertion' } } });
  script.supervisor.push({ text: 'Parked.' });
  const r = await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${created.id}`,
    headers: H, payload: { status: 'in_progress' } });
  assert.equal(json(r).ok, true, r.body);
  await engine.runLoop(wsId, created.seq);
  const t = await transcriptOf(
    (await db.select().from(loops).where(eq(loops.card, created.seq)))[0].codingSessionId);
  assert.match(t, /Build card \d+\./, 'the direct kickoff — the conversation-borne discriminator did the right thing');
  assert.doesNotMatch(t, /[Pp]lan card/, 'no planning language on the build-only path');
});

test('the token budget: seeded once, each turn added, breach blocks the card with the spend', async () => {
  const set = await app.inject({ method: 'PATCH', url: `/settings?workspace=${wsId}`, headers: H,
    payload: { loop_budget_tokens: 3 } });
  assert.equal(json(set).ok, true, set.body);
  try {
    const created = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
      payload: { title: 'expensive card', status: 'in_progress' } })).data.card;
    const engine = new LooperEngine({ db, pgPool, app, apiKey: 'test-key', modelFetch });
    // Every scripted call reports 1 input + 1 output. Kickoff turn: spend 2
    // (under 3, runs). Supervisor turn: spend 4 — the NEXT round breaches.
    script.coding.push({ text: 'working' });
    script.supervisor.push({ text: 'keep going' });
    await engine.runLoop(wsId, created.seq);
    const after = await cardRow(created.seq);
    assert.equal(after.status, 'blocked', 'the budget is the backstop — no run outlives it');
    assert.match(String(after.blocked_reason), /token budget exhausted: \d+ of 3 tokens/,
      'the board says the spend and the limit');
  } finally {
    const clear = await app.inject({ method: 'PATCH', url: `/settings?workspace=${wsId}`, headers: H,
      payload: { loop_budget_tokens: null } });
    assert.equal(json(clear).ok, true, clear.body);
  }
});

test('the routes ARE the trigger: a card patched into plan runs without anyone calling the engine', async () => {
  const engine = new LooperEngine({ db, pgPool, app, apiKey: 'test-key', modelFetch });
  ctx.looper = engine;   // what index.ts does after listen
  try {
    script.coding.push({ text: 'PLAN: via the route trigger.' });
    script.supervisor.push({ tool: { name: 'kanban_card_move',
      input: { status: 'blocked', reason: 'checked and parked' } } });
    script.supervisor.push({ text: 'Parked.' });
    const created = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
      payload: { title: 'route-driven card', status: 'backlog' } })).data.card;
    const r = await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${created.id}`,
      headers: H, payload: { status: 'plan' } });
    assert.equal(json(r).ok, true, r.body);
    // The PATCH poked the engine; the poke loop runs kickoff → review → the
    // move in the background. Poll the card — the state machine IS the evidence.
    const until = Date.now() + 10_000;
    let row = await cardRow(created.seq);
    while (row.status !== 'blocked' && Date.now() < until) {
      await new Promise((res) => setTimeout(res, 100));
      row = await cardRow(created.seq);
    }
    assert.equal(row.status, 'blocked', 'the verdict landed with no manual runTurn anywhere');
    assert.equal(row.blocked_reason, 'checked and parked');
  } finally {
    ctx.looper = undefined;   // later tests drive rounds by hand
  }
});

test('POST /sessions/:id/turn: a server-side turn is a normal turn — string in, ND-JSON out, record saved', async () => {
  const made = json(await app.inject({ method: 'POST', url: '/sessions', headers: H,
    payload: { workspace_id: wsId } })).data;
  script.coding.push({ text: 'hello from the server-side turn' });
  const r = await app.inject({ method: 'POST', url: `/sessions/${made.id}/turn`, headers: H,
    payload: { message: 'say hello' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.headers['content-type'], 'application/x-ndjson');
  const lines = r.body.trim().split('\n').map((l) => JSON.parse(l));
  const result = lines.at(-1)!;
  assert.equal(result.type, 'result');
  assert.equal(result.text, 'hello from the server-side turn');
  assert.ok(lines.some((l) => l.type === 'text'), 'text streamed as it happened');
  // A manual turn carries no block tool — that power exists only inside a run.
  const manualReq = wire.filter((w) => w.kind === 'coding').at(-1)!;
  const manualTools = (manualReq.body.tools as { name: string }[]).map((t) => t.name);
  assert.ok(!manualTools.includes('kanban_card_block'), 'kanban_card_block is loop-only');
  // The record is the same one every client reads — message and reply, whole.
  const t = json(await app.inject({ method: 'GET',
    url: `/sessions/${made.id}/transcript`, headers: H })).data.data as string;
  assert.match(t, /say hello/);
  assert.match(t, /hello from the server-side turn/);
  assert.match(t, /system_prompt/, 'the prompt froze into the header on the first save');
  // And the ephemeral turn lock is gone: a follow-up turn works at once.
  script.coding.push({ text: 'again' });
  const r2 = await app.inject({ method: 'POST', url: `/sessions/${made.id}/turn`, headers: H,
    payload: { message: 'again please' } });
  assert.equal(JSON.parse(r2.body.trim().split('\n').at(-1)!).text, 'again');
});

// The session's live feed — what makes a remote session watchable while it
// runs. Over a real socket (inject cannot hold a stream open), the board
// feed's shape exactly. The parts ride verbatim, so the cli folds them with
// the same reducer its own local turns use.
test('GET /sessions/:id/events streams a server-side turn as it happens, this session only', async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  const made = json(await app.inject({ method: 'POST', url: '/sessions', headers: H,
    payload: { workspace_id: wsId } })).data;
  const other = json(await app.inject({ method: 'POST', url: '/sessions', headers: H,
    payload: { workspace_id: wsId } })).data;
  const ac = new AbortController();
  const r = await fetch(`http://127.0.0.1:${port}/sessions/${made.id}/events`,
    { headers: { ...H, 'x-phantom-looper-client': 'watcher' }, signal: ac.signal });
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
    // A turn on ANOTHER session must never cross into this feed.
    script.coding.push({ text: 'not for the watcher' });
    await app.inject({ method: 'POST', url: `/sessions/${other.id}/turn`, headers: H,
      payload: { message: 'elsewhere' } });

    script.coding.push({ text: 'watch me work' });
    await app.inject({ method: 'POST', url: `/sessions/${made.id}/turn`,
      headers: { ...H, 'x-phantom-looper-client': 'the-runner' },
      payload: { message: 'do the thing' } });

    // First thing on the feed: who holds the session (nobody, at connect).
    const free = await next();
    assert.equal(free.event, 'lock');
    assert.equal(free.locked, false);
    // The turn takes the hold: the spinner's record, before any part.
    const held = await next();
    assert.equal(held.event, 'lock');
    assert.equal(held.locked, true);
    assert.equal(held.by, 'the-runner');
    assert.equal(held.agent, null, 'a manual turn: no seat, so no "who" — just the label');
    assert.ok(typeof held.expires_at === 'string');
    const start = await next();
    assert.equal(start.event, 'turn-start');
    assert.equal(start.agent, 'coding');
    assert.equal(start.message, 'do the thing', 'the watcher sees what the turn is answering');

    const seen: Record<string, unknown>[] = [];
    let rec = await next();
    while (rec.event === 'part') { seen.push(rec.part as Record<string, unknown>); rec = await next(); }
    assert.ok(seen.some((p) => p.type === 'text-delta' && String(p.text).includes('watch')),
      'the reply streamed part by part, verbatim');
    assert.equal(rec.event, 'turn-end');

    // The record landing is its own event — the signal to re-read — and it
    // names the writer so a window ignores the echo of its own upload.
    const landed = await next();
    assert.equal(landed.event, 'transcript');
    assert.equal(landed.by, 'the-runner');
    assert.ok(typeof landed.updated_at === 'string' && landed.updated_at.length > 0);
    // The save renews the hold; the turn's close releases it — both on the feed.
    const renewed = await next();
    assert.equal(renewed.event, 'lock');
    assert.equal(renewed.locked, true);
    const released = await next();
    assert.equal(released.event, 'lock');
    assert.equal(released.locked, false, 'the spinner clears the moment the turn lets go');
  } finally {
    // The socket goes; the app stays up for the tests after this one (the
    // after() hook closes it) — inject works listening or not.
    ac.abort();
  }
});

// A turn the server does NOT run — a cli window driving the model on its own
// machine — reaches the same feed through POST /sessions/:id/events. One feed,
// whoever drives: the watcher cannot tell the two apart. Only the lock holder
// may publish, and nobody hears themselves.
test('a cli-run turn is relayed: the holder publishes, a watcher sees it verbatim, the publisher never hears itself', async () => {
  if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  const made = json(await app.inject({ method: 'POST', url: '/sessions', headers: H,
    payload: { workspace_id: wsId } })).data;
  const A = { ...H, 'x-phantom-looper-client': 'window-a' };
  const B = { ...H, 'x-phantom-looper-client': 'window-b' };

  const ac = new AbortController();
  const open = async (headers: Record<string, string>) => {
    const r = await fetch(`http://127.0.0.1:${port}/sessions/${made.id}/events`, { headers, signal: ac.signal });
    assert.equal(r.status, 200);
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const got: Record<string, unknown>[] = [];
    const waiting: ((rec: Record<string, unknown>) => void)[] = [];
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const rec = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
            if (rec.event === 'heartbeat') continue;
            const w = waiting.shift();
            if (w) w(rec); else got.push(rec);
          }
        }
      } catch { /* aborted */ }
    })();
    return {
      got,
      next: () => got.length ? Promise.resolve(got.shift()!)
        : new Promise<Record<string, unknown>>((res) => waiting.push(res)),
    };
  };
  try {
    const a = await open(A);
    const b = await open(B);
    assert.equal((await b.next()).locked, false, 'the feed opens with the hold: nobody');
    const publish = (headers: Record<string, string>, events: unknown[]) =>
      app.inject({ method: 'POST', url: `/sessions/${made.id}/events`, headers, payload: { events } });

    // Nobody holds the session: no one may publish on it.
    let r = await publish(A, [{ event: 'turn-start', agent: 'coding', message: 'x' }]);
    assert.equal(r.statusCode, 409, 'publishing needs the lock');
    assert.equal(json(r).error.code, 'session_not_held');

    // A takes the lock (its turn starts) and relays what it draws, batched.
    assert.equal((await app.inject({ method: 'POST', url: `/sessions/${made.id}/lock`, headers: A,
      payload: { label: 'laptop-a' } })).statusCode, 200);
    r = await publish(B, [{ event: 'turn-end' }]);
    assert.equal(r.statusCode, 409, 'and only the holder has it');
    assert.equal(json(r).error.code, 'session_locked');

    const big = 'x'.repeat(20 * 1024);
    r = await publish(A, [{ event: 'turn-start', agent: 'coding', message: 'do it from my laptop' }]);
    assert.equal(r.statusCode, 200);
    assert.equal(json(r).data.published, 1);
    r = await publish(A, [
      { event: 'part', part: { type: 'text-start', id: '0' } },
      { event: 'part', part: { type: 'text-delta', id: '0', text: 'typed on a' } },
      { event: 'part', part: { type: 'tool-result', toolCallId: 'c1', toolName: 'read', output: big } },
    ]);
    assert.equal(json(r).data.published, 3);

    // The turn's START is when the list moves: the preview is what was just
    // typed, and a first message names the session — no reply, no save yet.
    await new Promise((res) => setTimeout(res, 150));
    let row = json(await app.inject({ method: 'GET', url: `/sessions/${made.id}`, headers: H })).data;
    assert.equal(row.lastUserMessage, 'do it from my laptop', 'the preview moved at turn start');
    assert.equal(row.name, 'Scripted session title', 'named off the first message, before the turn ended');

    await publish(A, [{ event: 'turn-end' }]);

    // B sees the turn exactly as it would see a server-run one — the hold first.
    const hold = await b.next();
    assert.equal(hold.event, 'lock');
    assert.equal(hold.locked, true);
    assert.equal(hold.label, 'laptop-a', "the holder's own word for itself");
    const start = await b.next();
    assert.equal(start.event, 'turn-start');
    assert.equal(start.message, 'do it from my laptop');
    assert.deepEqual(await b.next(), { event: 'part', part: { type: 'text-start', id: '0' } });
    assert.deepEqual(await b.next(), { event: 'part', part: { type: 'text-delta', id: '0', text: 'typed on a' } });
    const capped = (await b.next()).part as { capped?: boolean; output: string };
    assert.equal(capped.capped, true, 'a relayed tool result is capped like every other publisher\'s');
    assert.ok(capped.output.length < big.length);
    assert.deepEqual(await b.next(), { event: 'turn-end' });

    // A's record lands: B is told, by whom.
    const header = JSON.stringify({ type: 'session', session_id: made.id, provider: 'anthropic', model: 'claude-fable-5', created_at: new Date().toISOString() });
    r = await app.inject({ method: 'PUT', url: `/sessions/${made.id}/transcript`, headers: A,
      payload: { data: `${header}\n${JSON.stringify({ role: 'user', content: 'do it from my laptop' })}\n` } });
    assert.equal(r.statusCode, 200);
    const landed = await b.next();
    assert.equal(landed.event, 'transcript');
    assert.equal(landed.by, 'window-a');

    assert.equal((await b.next()).event, 'lock', 'the save renewed the hold');
    await app.inject({ method: 'DELETE', url: `/sessions/${made.id}/lock`, headers: A });
    assert.equal((await b.next()).locked, false, 'and the release clears it');

    // A loop seat is NOT named off its first message — that is the loop's
    // fixed kickoff text, the same on every card. The save names it later.
    const seat = json(await app.inject({ method: 'POST', url: '/sessions', headers: H,
      payload: { workspace_id: wsId } })).data;
    await stampAgent(db, seat.id, 'coding');
    await app.inject({ method: 'POST', url: `/sessions/${seat.id}/lock`, headers: A, payload: {} });
    await app.inject({ method: 'POST', url: `/sessions/${seat.id}/events`, headers: A,
      payload: { events: [{ event: 'turn-start', agent: 'coding', message: 'Plan card 1. Your tools are read-only.' }] } });
    await new Promise((res) => setTimeout(res, 150));
    row = json(await app.inject({ method: 'GET', url: `/sessions/${seat.id}`, headers: H })).data;
    assert.equal(row.lastUserMessage, 'Plan card 1. Your tools are read-only.', 'the preview still moves');
    assert.equal(row.name, null, 'but no title off a kickoff');

    // A heard NONE of it — not its lock, not its turn, not its parts, not
    // its own save. Only the feed's opening record, from before it held.
    await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(a.got.map((e) => [e.event, e.locked]), [['lock', false]],
      'the feed never hands a client its own events back');
  } finally {
    ac.abort();
  }
});

test('a turn with nobody watching saves the same record — the stream is the only path now', async () => {
  const made = json(await app.inject({ method: 'POST', url: '/sessions', headers: H,
    payload: { workspace_id: wsId } })).data;
  script.coding.push({ text: 'unwatched but recorded' });
  const r = await app.inject({ method: 'POST', url: `/sessions/${made.id}/turn`, headers: H,
    payload: { message: 'nobody is looking' } });
  assert.equal(JSON.parse(r.body.trim().split('\n').at(-1)!).text, 'unwatched but recorded');
  const t = json(await app.inject({ method: 'GET',
    url: `/sessions/${made.id}/transcript`, headers: H })).data.data as string;
  assert.match(t, /nobody is looking/, 'the user message is in the record');
  assert.match(t, /unwatched but recorded/, 'and the whole reply');
  assert.match(t, /"type":"usage"/, 'with its usage line — the record is complete without a subscriber');
});

test('the turn route respects the session lock: 409 while someone else holds it', async () => {
  const made = json(await app.inject({ method: 'POST', url: '/sessions', headers: H,
    payload: { workspace_id: wsId } })).data;
  const held = await app.inject({ method: 'POST', url: `/sessions/${made.id}/lock`,
    headers: { ...H, 'x-phantom-looper-client': 'someone-else' }, payload: { label: 'laptop' } });
  assert.equal(json(held).ok, true, held.body);
  const r = await app.inject({ method: 'POST', url: `/sessions/${made.id}/turn`, headers: H,
    payload: { message: 'hi' } });
  assert.equal(r.statusCode, 409);
  assert.equal(json(r).error.code, 'session_locked');
});
