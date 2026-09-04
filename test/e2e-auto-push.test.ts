// The WHOLE journey, end to end: an auto-run card walks plan → in_progress
// → done with the coding agent REALLY writing a file (a real workspace
// container, POST /tools/write against a real checkout), a human archives the
// card, and auto-push carries the work onto origin/main — model-written commit
// message included. Models are scripted at the wire (createAgent's fetch
// seam); every route, lock, container and git operation in between is real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { and, eq } from 'drizzle-orm';
import { testDb, ensureWorkspaceImage, testRoot, setWorkspaceSetting } from './harness.js';
import { makePaths, repoDir, type Paths } from '../phantom-backend/pool/paths.js';
import { bootCleanup } from '../phantom-backend/pool/pool.js';
import { buildApp } from '../phantom-backend/api/app.js';
import { makeDocker } from '../phantom-backend/docker.js';
import { ContainerManager } from '../phantom-backend/workspace/container.js';
import { autoPush } from '../phantom-backend/git/autoPush.js';
import { newId } from '../core/ids.js';
import { workspaces, sessions, loops, folders } from '../phantom-backend/db/schema.js';
import { LooperEngine } from '../phantom-backend/looper/engine.js';
import type { CardRow } from '../phantom-backend/looper/logic.js';

const FS_IMAGE = 'phantom-test-fs';
let db: Awaited<ReturnType<typeof testDb>>['db'];
let pgPool: Awaited<ReturnType<typeof testDb>>['pool'];
let app: Awaited<ReturnType<typeof buildApp>>;
let containers: ContainerManager;
let paths: Paths;
let root: string;
let bare: string;
let wsId: string;
let schema: string;
let workspace: typeof workspaces.$inferSelect;

const H = { authorization: 'Bearer test-key' };
const json = (r: { body: string }) => JSON.parse(r.body);
const KEY = Buffer.alloc(32, 7);

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false',
    '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });
}

// ── the scripted model wire — looper.test.ts's, plus tool calls ─────────────
// A queued reply is either text (the turn ends) or a TOOL CALL: the agent
// loop then really executes it — the coder's file tools against the
// container, the supervisor's status tools against the live card routes —
// and comes back for the next queued item.
type Scripted = string | { tool: string; input: Record<string, unknown> };
const replies: { supervisor: Scripted[]; coding: Scripted[] } = { supervisor: [], coding: [] };

function sseFor(item: Scripted): string {
  const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const head = ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message',
    role: 'assistant', model: 'claude-fable-5', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 0 } } });
  if (typeof item === 'string') {
    return head
      + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: item } })
      + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
      + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
      + ev('message_stop', { type: 'message_stop' });
  }
  return head
    + ev('content_block_start', { type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: `toolu_${Date.now()}`, name: item.tool, input: {} } })
    + ev('content_block_delta', { type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(item.input) } })
    + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
    + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } })
    + ev('message_stop', { type: 'message_stop' });
}

const modelFetch: typeof fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  const sys = JSON.stringify(body.system ?? '');
  // Session-title calls ride the same wire (fired by transcript saves) but
  // are not part of any script: answer out-of-band, touch no queue.
  if (sys.includes('You name coding-agent sessions')) {
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
  const item = replies[kind].shift() ?? '(script ran dry)';
  if (body.stream === true) {
    return new Response(sseFor(item), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  // Non-streaming call — looper turns (agent.generate) and the auto-push commit
  // message both come through here; a queued tool call answers as tool_use.
  const content = typeof item === 'string'
    ? [{ type: 'text', text: item }]
    : [{ type: 'tool_use', id: `toolu_${Date.now()}`, name: item.tool, input: item.input }];
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'scripted',
    content, stop_reason: typeof item === 'string' ? 'end_turn' : 'tool_use',
    stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

before(async () => {
  await ensureWorkspaceImage();
  ({ db, pool: pgPool } = await testDb('e2epush'));
  root = await testRoot('phantom-e2e-');
  paths = makePaths(path.join(root, 'workspaces'));
  await bootCleanup(paths);

  bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['clone', '-q', bare, seed]);
  sh(seed, ['checkout', '-qb', 'main']);
  await fs.writeFile(path.join(seed, 'README.md'), 'the fixture repo\n');
  sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'first']); sh(seed, ['push', '-q', 'origin', 'main']);

  const docker = makeDocker();
  containers = new ContainerManager(docker, paths);
  await containers.bootCleanup();

  // auto-push wired the way index.ts wires it, minus the fixer (this journey has
  // no conflict) — the commit message model is the scripted wire.
  app = await buildApp({
    db, paths, apiKey: 'test-key', encryptionKey: KEY, version: 'test', pgPool,
    fs: { docker, containers },
    modelFetch,
    autoPush: (session, workspace_, onEvent) => autoPush({
      db, paths, encryptionKey: KEY, onEvent,
      messageConfig: async () => ({ provider: 'anthropic', model: 'claude-fable-5',
        apiKey: 'sk-ant-api03-test', fetch: modelFetch }),
    }, session, workspace_),
  });

  wsId = newId();
  schema = `wsp_${wsId}`;
  await db.insert(workspaces).values({
    id: wsId, url: `file://${bare}`, owner: 'local', name: 'journey',
    baseBranch: 'main', branchPrefix: 'agent', schemaName: schema,
  });
  const { ensureWorkspaceSchema } = await import('../phantom-backend/db/workspaceSchema.js');
  await ensureWorkspaceSchema(pgPool, wsId, schema);
  await setWorkspaceSetting(db, wsId, 'auto_plan', true);
  await setWorkspaceSetting(db, wsId, 'auto_build', true);
  await setWorkspaceSetting(db, wsId, 'container_image', FS_IMAGE);
  const r = await app.inject({ method: 'PATCH', url: '/settings', headers: H,
    payload: { provider: 'anthropic', model: 'claude-fable-5', anthropic_api_key: 'sk-ant-api03-test' } });
  assert.equal(json(r).ok, true, r.body);
  const sr = await app.inject({ method: 'PATCH', url: `/settings?workspace=${wsId}`, headers: H,
    payload: { auto_push_on_archive: true } });
  assert.equal(json(sr).ok, true, sr.body);
  workspace = (await db.select().from(workspaces).where(eq(workspaces.id, wsId)))[0];
});

after(async () => {
  await containers?.bootCleanup();
  await app?.close();
  await pgPool?.end();
  await fs.rm(root, { recursive: true, force: true });
});

async function cardRow(seq: number): Promise<CardRow> {
  const r = await pgPool.query(`select * from "${schema}".cards where seq = $1`, [seq]);
  return r.rows[0] as CardRow;
}

test('a card travels the whole system: plan → execute (real file write) → done → archive → pushed onto main', async () => {
  const engine = new LooperEngine({ db, pgPool, app, apiKey: 'test-key', modelFetch });
  const budget = { seeded: false, spent: 0, limit: null };

  // The card a person would write.
  const created = json(await app.inject({ method: 'POST', url: `/workspaces/${wsId}/cards`, headers: H,
    payload: { title: 'E2E test: add hello.txt', status: 'plan',
      details: 'Create hello.txt containing exactly "hello from the card".',
      requirements: [{ text: 'hello.txt exists with the right content' }] } })).data.card;
  const seq: number = created.seq;
  const reqKey: string = created.requirements[0].key;

  // Round 1 — the plan kickoff; the coding agent plans in text.
  replies.coding.push('PLAN: write hello.txt with the exact content, then read it back to verify.');
  await engine.runTurn(workspace, await cardRow(seq), budget);
  const loopRow = (await db.select().from(loops).where(eq(loops.card, seq)))[0];
  assert.ok(loopRow, 'the loop row exists');
  const srow = (await db.select().from(sessions).where(eq(sessions.id, loopRow.codingSessionId)))[0];
  assert.ok(srow, 'the loop stamped a coding session for the card');

  // Round 2 — the supervisor approves the plan by MOVING the card: the tool
  // is the verdict, executed for real against the live card routes.
  replies.supervisor.push({ tool: 'kanban_card_move', input: { status: 'in_progress', reason: 'plan approved' } });
  replies.supervisor.push('Approved.');
  await engine.runTurn(workspace, await cardRow(seq), budget);
  assert.equal((await cardRow(seq)).status, 'in_progress');

  // Round 3 — execution, FOR REAL: the scripted model calls the write tool,
  // the server runs it against the workspace container, the checkout changes.
  replies.coding.push({ tool: 'write', input: { path: 'hello.txt', content: 'hello from the card\n' } });
  replies.coding.push('Done: hello.txt written and verified.');
  await engine.runTurn(workspace, await cardRow(seq), budget);
  const onDisk = await fs.readFile(path.join(repoDir(paths, srow.id), 'hello.txt'), 'utf8');
  assert.equal(onDisk, 'hello from the card\n', 'the file is really in the checkout — no mock anywhere below the model');

  // Round 4 — the supervisor verifies, ticks the requirement through its own
  // items tool, and ends the run with move(done).
  replies.supervisor.push({ tool: 'kanban_card_items', input: { ops: [{ op: 'tick', key: reqKey, done: true }] } });
  replies.supervisor.push({ tool: 'kanban_card_move', input: { status: 'done', reason: 'verified against the repo' } });
  replies.supervisor.push('Verified: hello.txt holds the exact content.');
  await engine.runTurn(workspace, await cardRow(seq), budget);
  const done = await cardRow(seq);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.requirements, [{ key: reqKey, text: 'hello.txt exists with the right content', done: true }]);

  // The human reviews at done and ARCHIVES — auto_push_on_archive carries the work
  // to main. The commit message is model-written from the diff (queued here).
  replies.coding.push('Add hello.txt with the card\'s greeting');
  const mainBefore = execFileSync('git', ['-C', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  const patched = await app.inject({ method: 'PATCH', url: `/workspaces/${wsId}/cards/${done.id}`,
    headers: H, payload: { archived: true } });
  assert.equal(patched.statusCode, 200, patched.body);

  // Auto-push runs detached; wait for main to move.
  let mainAfter = mainBefore;
  for (let i = 0; i < 100 && mainAfter === mainBefore; i++) {
    await new Promise((r) => setTimeout(r, 200));
    mainAfter = execFileSync('git', ['-C', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  }
  assert.notEqual(mainAfter, mainBefore, 'auto-push landed on main');

  // What landed is the work, under the model-written message, with the trailer.
  const landed = execFileSync('git', ['-C', bare, 'show', 'main:hello.txt'], { encoding: 'utf8' });
  assert.equal(landed, 'hello from the card\n');
  const log = execFileSync('git', ['-C', bare, 'log', '--format=%B', '-1', 'main'], { encoding: 'utf8' });
  assert.match(log, /Add hello\.txt with the card's greeting/);
  assert.match(log, new RegExp(`Phantom-Session: ${srow.id}`));
  // The branch backup went too, and main is a fast-forward of it.
  const srowFolder = (await db.select().from(folders).where(eq(folders.id, String(srow.folderId))))[0];
  const branchSha = execFileSync('git', ['-C', bare, 'rev-parse', `refs/heads/${srowFolder.branch}`], { encoding: 'utf8' }).trim();
  assert.equal(branchSha, mainAfter, 'main is exactly the pushed branch HEAD');
  // The card stayed archived — archived = complete, and this one completed.
  const final = await cardRow(seq);
  assert.equal(final.archived, true);
  assert.equal(final.status, 'done');
});
