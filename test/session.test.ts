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

// ── headerModelFromJsonl ──────────────────────────────────────────────────────
import { headerModelFromJsonl } from '../core/llm/transcript.js';

test('headerModelFromJsonl extracts provider, model and endpoint from a session transcript header', () => {
  const header = JSON.stringify({ type: 'session', provider: 'anthropic', model: 'claude-sonnet-4-20250514',
    base_url: 'https://gateway.example/v1', created_at: '' });
  const jsonl = `${header}\n{"role":"user","content":"hello"}\n`;
  assert.deepEqual(headerModelFromJsonl(jsonl),
    { provider: 'anthropic', model: 'claude-sonnet-4-20250514', baseUrl: 'https://gateway.example/v1' });
  // A header from before the endpoint was recorded: the pair, no endpoint.
  assert.deepEqual(headerModelFromJsonl('{"type":"session","provider":"openai","model":"gpt-5"}'),
    { provider: 'openai', model: 'gpt-5', baseUrl: null });
  // Non-session headers return nulls.
  assert.deepEqual(headerModelFromJsonl('{"type":"other"}'), { provider: null, model: null, baseUrl: null });
  // Unparsable text returns nulls (never throws).
  assert.deepEqual(headerModelFromJsonl('not json'), { provider: null, model: null, baseUrl: null });
  // Empty string returns nulls.
  assert.deepEqual(headerModelFromJsonl(''), { provider: null, model: null, baseUrl: null });
});

// ── stripUsageFromJsonl ───────────────────────────────────────────────────────
import { stripUsageFromJsonl, sumUsageFromJsonl } from '../core/llm/transcript.js';

test('stripUsageFromJsonl drops usage lines and nothing else — a duplicate counts its own spend', () => {
  const jsonl = [
    JSON.stringify({ type: 'session', provider: 'p', model: 'm', created_at: '' }),
    JSON.stringify({ role: 'user', content: 'hello' }),
    JSON.stringify({ type: 'usage', input: 100, output: 10, cache_read: 80, cache_write: 5 }),
    JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'mentions "usage" in prose' }] }),
    'not json at all',
    JSON.stringify({ type: 'model', provider: 'p', model: 'm2' }),
  ].join('\n') + '\n';
  const stripped = stripUsageFromJsonl(jsonl);
  const lines = stripped.trim().split('\n');
  assert.equal(lines.length, 5, 'only the usage line is gone');
  assert.ok(!stripped.includes('"type":"usage"'), 'no usage line survives');
  assert.deepEqual(sumUsageFromJsonl(stripped), { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    'the copy sums to zero — its own spend from birth');
  // Prose mentioning "usage" (escaped inside its message's JSON) and
  // unparsable lines are kept: the cheap gate must not eat a message.
  assert.ok(lines.some((l) => l.includes('mentions \\"usage\\" in prose')));
  assert.ok(lines.includes('not json at all'));
});

// ── Transcript.setModel ───────────────────────────────────────────────────────
import { Transcript } from '../core/llm/transcript.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('setModel re-points the header on disk and in memory, keeping the frozen prompt; undefined drops the endpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phantom-setmodel-'));
  const file = join(dir, 's.jsonl');
  const t = new Transcript({ type: 'session', provider: 'anthropic', model: 'm0',
    base_url: 'https://old.example', created_at: 'then', system_prompt: 'FROZEN' }, file);

  // Not started (no file): the first append writes the NEW header.
  t.setModel({ provider: 'openai', model: 'm1', base_url: null });
  t.append({ role: 'user', content: 'hi' });
  let header = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]);
  assert.equal(header.provider, 'openai');
  assert.equal(header.model, 'm1');
  assert.ok(!('base_url' in header), 'a provider switch must not inherit the old endpoint');
  assert.equal(header.system_prompt, 'FROZEN', 'the frozen prompt is untouched');

  // Started: line 1 on disk moves, the rest of the file does not.
  t.setModel({ provider: 'google', model: 'm2', base_url: 'https://new.example' });
  const lines = readFileSync(file, 'utf8').split('\n');
  header = JSON.parse(lines[0]);
  assert.equal(header.provider, 'google');
  assert.equal(header.base_url, 'https://new.example');
  assert.deepEqual(JSON.parse(lines[1]), { role: 'user', content: 'hi' }, 'the messages are untouched');
});
