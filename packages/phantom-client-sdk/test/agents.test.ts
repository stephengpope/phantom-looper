// The three shipped agents: prompt built from the API and frozen, the
// right kits, the loop kits bound to one card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodingAgent, codingPromptBlocks } from '../src/agents/coding/index.js';
import { SupervisorAgent, toCodingAgent, firstLine } from '../src/agents/supervisor/index.js';
import { AssistantAgent } from '../src/agents/assistant/index.js';
import { loopBlockToolKit, loopSupervisorToolKit } from '../src/kits/kanban.js';
import { ToolKitSet } from '../src/toolkit.js';
import { harness } from './testAgent.js';

test('CodingAgent.create: two blocks from skills, secrets, settings and SOUL.md, frozen on the row', async () => {
  const h = harness();
  h.fake.settings = { timezone: { value: 'UTC' }, agent_soul: { value: true }, agent_git_credentials: { value: true } };
  const a = await CodingAgent.create(h.fake.backend, h.handlers, { workspaceId: 'w1' });
  const blocks = h.fake.sessions.get(a.sessionId)!.system_prompt!;
  assert.equal(blocks.length, 2);
  assert.match(blocks[0]!, /^You are a value-based coding agent/);
  assert.match(blocks[1]!, /- deploy: How to deploy/);
  assert.match(blocks[1]!, /- GH_TOKEN: GitHub/);
  assert.match(blocks[1]!, /GITHUB_TOKEN/);
  assert.match(blocks[1]!, /I am the soul\./);
  assert.match(blocks[1]!, /Current date: \d{4}-\d{2}-\d{2}\.$/);
  assert.doesNotMatch(blocks[1]!, /^\s*\d+\t/m);   // line numbers stripped
  assert.deepEqual(h.errors, []);
});

test('codingPromptBlocks: off facts vanish, nothing is left blank', () => {
  const [base, ws] = codingPromptBlocks({ skills: [], secrets: [], credentials: false, database: false, databaseShared: false,
    soul: '', agents: '', date: '2026-09-24' });
  assert.doesNotMatch(base!, /\{\{/);
  assert.doesNotMatch(ws!, /\{\{/);
  assert.doesNotMatch(ws!, /GITHUB_TOKEN|skills|secrets/i);
  assert.match(ws!, /Git operations are normally covered/);
});

test('SupervisorAgent: one block, inspection-only workspace tools', async () => {
  const h = harness();
  const a = await SupervisorAgent.create(h.fake.backend, h.handlers, { workspaceId: 'w1', folderId: 'f-coder', cardId: 7 });
  const blocks = h.fake.sessions.get(a.sessionId)!.system_prompt!;
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]!, /^You are the supervisor/);
  const kits = new ToolKitSet();
  for (const k of (a as unknown as { toolKits(): never[] }).toolKits()) kits.add(k);
  const tools = await kits.resolve({ backend: h.fake.backend, sessionId: a.sessionId, workspaceId: 'w1', folderId: 'f-coder', readonly: () => false });
  assert.deepEqual(Object.keys(tools).sort(), ['kanban_card_read', 'read', 'web_fetch', 'web_search']);
});

test('loop kits are bound to one card and end the run through the card PATCH', async () => {
  const h = harness();
  const kits = new ToolKitSet();
  kits.add(loopSupervisorToolKit(7, 'plan'));
  kits.add(loopBlockToolKit(7));
  const tools = await kits.resolve({ backend: h.fake.backend, sessionId: 's', workspaceId: 'w1', folderId: null, readonly: () => true });
  assert.deepEqual(Object.keys(tools).sort(), ['kanban_card_block', 'kanban_card_items', 'kanban_card_move']);
  // Readonly does not trim them: board powers in a run are the point of the run.
  await tools.kanban_card_block!.execute!({ reason: 'need a human' }, { toolCallId: 'x', messages: [] } as never);
  const patch = h.fake.requests.find((r) => r.method === 'PATCH');
  assert.equal(patch?.path, '/workspaces/w1/cards/7');
  assert.deepEqual(patch?.body, { status: 'blocked', blocked_reason: 'need a human', resolution: null });
});

test('the loop messages and their frozen first lines agree', () => {
  const card = { number: 7, title: 't', status: 'plan', details: 'd', requirements: [] };
  assert.ok(toCodingAgent.planCard(card).startsWith(firstLine.planCard(7)));
  assert.ok(toCodingAgent.buildFromCard(card).startsWith(firstLine.buildFromCard(7)));
});

test('AssistantAgent: no folder = no file tools; follow moves the folder and the next resolve rebuilds', async () => {
  const h = harness();
  const a = await AssistantAgent.create(h.fake.backend, h.handlers, { workspaceId: 'w1' });
  const kits = new ToolKitSet();
  for (const k of (a as unknown as { toolKits(): never[] }).toolKits()) kits.add(k);
  const ctx = () => ({ backend: h.fake.backend, sessionId: a.sessionId, workspaceId: 'w1', folderId: a.row.folderId, readonly: () => false });
  let tools = await kits.resolve(ctx());
  assert.ok(!('read' in tools));
  assert.ok('kanban_card_create' in tools && 'git_auto_push' in tools);
  await a.follow('s-on-screen', 'w1');
  tools = await kits.resolve(ctx());
  assert.ok('read' in tools);
  assert.ok(!('bash' in tools));
});
