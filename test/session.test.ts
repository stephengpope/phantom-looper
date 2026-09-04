// core/session.ts — the ONE way anything obtains a working session. Driven
// with a scripted ApiCall, no network: resolve modes, the lock contract, the
// transcript-is-the-record rule, and the frozen-prompt resolution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSession, SessionLockedError, type ApiCall } from '../core/session.js';
import { pickKit } from '../core/llm/tools/presets.js';
import { tool } from 'ai';
import { z } from 'zod';

function scripted(routes: Record<string, unknown>, calls: string[] = []) {
  const call: ApiCall = async (method, path, body) => {
    calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`);
    const hit = routes[`${method} ${path}`];
    if (hit === undefined) throw new Error(`unexpected ${method} ${path}`);
    if (hit instanceof Error) throw hit;
    return hit;
  };
  return { call, calls };
}

const CREATED = { id: 's1', workspaceId: 'w1', branch: 'agent/s1', status: 'active',
  skills: [{ name: 'deploy', description: 'ship it' }], agent_git_credentials: false };

test('create: POST → transcript, NO lock — opening is reading', async () => {
  const { call, calls } = scripted({
    'POST /sessions': CREATED,
    'GET /sessions/s1/transcript': { data: null },
  });
  const o = await openSession({ call, workspaceId: 'w1', label: 'host' });
  assert.equal(o.created, true);
  assert.equal(o.session.id, 's1');
  assert.deepEqual(o.messages, []);
  assert.equal(o.raw, null);
  assert.match(o.instructions, /deploy/, 'the skills index rides the assembled prompt');
  assert.match(o.instructions, /Git operations are normally covered/, 'git facts stated');
  assert.deepEqual(calls, [
    'POST /sessions {"workspace_id":"w1"}',
    'GET /sessions/s1/transcript',
  ], 'no lock call anywhere — locks are per turn, taken by writers');
});

test('lock: true takes the hold for the open (the looper and the turn route)', async () => {
  const { call, calls } = scripted({
    'POST /sessions': CREATED,
    'POST /sessions/s1/lock': { locked: true },
    'GET /sessions/s1/transcript': { data: null },
    'DELETE /sessions/s1/lock': { released: true },
  });
  const o = await openSession({ call, workspaceId: 'w1', label: 'host', lock: true });
  assert.ok(calls.includes('POST /sessions/s1/lock {"label":"host"}'), 'the writer locked');
  await o.close();
  assert.ok(calls.includes('DELETE /sessions/s1/lock'), 'and close released it');
});

test('attach: an active session is not re-created, and the frozen header prompt wins verbatim', async () => {
  const jsonl = [
    JSON.stringify({ type: 'session', agent: 'coding', provider: 'p', model: 'm',
      created_at: 'now', system_prompt: 'FROZEN, EXACTLY' }),
    JSON.stringify({ role: 'user', content: 'hi' }),
    JSON.stringify({ role: 'assistant', content: 'hello' }),
  ].join('\n');
  const { call, calls } = scripted({
    'GET /sessions/s1': { id: 's1', workspaceId: 'w1', branch: 'agent/s1', status: 'active' },
    'GET /sessions/s1/transcript': { data: jsonl },
  });
  const o = await openSession({ call, sessionId: 's1' });
  assert.equal(o.created, false);
  assert.equal(o.instructions, 'FROZEN, EXACTLY', 'the stored prompt replays verbatim — never reassembled');
  assert.equal(o.messages.length, 2, 'the server record is the working memory');
  assert.equal(o.raw, jsonl);
  assert.ok(!calls.some((c) => c.startsWith('POST /sessions ')), 'no create for an active session');
});

test('restart: a destroyed session is recreated by id, same branch semantics as ever', async () => {
  const { call, calls } = scripted({
    'GET /sessions/s1': { id: 's1', workspaceId: 'w1', branch: 'agent/s1', status: 'destroyed' },
    'POST /sessions': { ...CREATED },
    'GET /sessions/s1/transcript': { data: null },
  });
  const o = await openSession({ call, sessionId: 's1' });
  assert.equal(o.created, true);
  assert.ok(calls.includes('POST /sessions {"workspace_id":"w1","id":"s1"}'), 'restart names the id');
});

test('a held session throws SessionLockedError only for a LOCKING open', async () => {
  const { call } = scripted({
    'GET /sessions/s1': { id: 's1', workspaceId: 'w1', branch: 'agent/s1', status: 'active' },
    'GET /sessions/s1/transcript': { data: null },
    'POST /sessions/s1/lock': new Error('POST lock: session_locked in use on laptop'),
  });
  const o = await openSession({ call, sessionId: 's1' });
  assert.equal(o.session.id, 's1', 'a plain open READS a held session — no lock, no refusal');
  await assert.rejects(() => openSession({ call, sessionId: 's1', lock: true }), SessionLockedError);
});

// ── kit presets (core/llm/tools/presets.ts) ────────────────────────────────

const fakeKit = () => ({
  read: tool({ description: 'r', inputSchema: z.object({}), execute: async () => 'r' }),
  write: tool({ description: 'w', inputSchema: z.object({}), execute: async () => 'w' }),
  bash: tool({ description: 'b', inputSchema: z.object({}), execute: async () => 'b' }),
});

test('pickKit: full, readonly (drops declared mutators), explicit list; unknown names throw', () => {
  const kit = fakeKit();
  assert.deepEqual(Object.keys(pickKit(kit, ['write', 'bash'])), ['read', 'write', 'bash']);
  assert.deepEqual(Object.keys(pickKit(kit, ['write', 'bash'], 'readonly')), ['read']);
  assert.deepEqual(Object.keys(pickKit(kit, ['write', 'bash'], ['read', 'bash'])), ['read', 'bash']);
  assert.throws(() => pickKit(kit, ['write'], ['nope']), /unknown tool/);
  assert.throws(() => pickKit(kit, ['not-a-tool'], 'readonly'), /unknown mutating tool/,
    'a mutator list naming a missing tool is a drifted declaration, caught loudly');
});
