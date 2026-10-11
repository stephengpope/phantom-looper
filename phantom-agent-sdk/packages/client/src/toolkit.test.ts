// The server tool kit against a fake backend: a tool call is POSTed once,
// never under the connection's retry rule — a 5xx (a timed-out command) is
// the model's to act on, not the transport's to repeat — and whether the
// api filed the result is a fact the kit reports, never a guess by tool
// name: a refusal made here is nobody's but this side's. Run: npm test
// (tsx --test) in this package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverToolKit, ToolKitSet, TOOL_CALL_HEADER, type ToolKitContext } from './toolkit.js';
import type { BackendClient } from './backend.js';

const listing = [{ name: 'bash', summary: 'run', description: 'run a command', input: { type: 'object' }, mutates: true }];

function fakeBackend(answer: unknown) {
  const requests: Array<{ method: string; path: string; body: unknown; opts: Record<string, unknown> }> = [];
  const backend = {
    callRaw: async (method: string, path: string, body: unknown, opts: Record<string, unknown>) => {
      requests.push({ method, path, body, opts });
      return answer;
    },
  } as unknown as BackendClient;
  return { backend, requests };
}

function context(backend: BackendClient, readonly = false) {
  const filed: string[] = [];
  const recorded: unknown[] = [];
  const ctx: ToolKitContext = {
    backend, sessionId: 's1', projectId: 'p1', workspaceId: 'w1', readonly: () => readonly,
    filed: (id) => { filed.push(id); }, recorded: (written) => { recorded.push(written); },
  };
  return { ctx, filed, recorded };
}

test('a server tool call is sent once: retry off, the call id in its header, the result filed by the api', async () => {
  const { backend, requests } = fakeBackend({ ok: false, error: { code: 'exec_timeout', message: 'killed after 240000ms', retryable: true } });
  const { ctx, filed, recorded } = context(backend);
  const built = await serverToolKit(listing).build(ctx);
  const answer = await built.tools.bash!.execute!({ command: 'sleep 999' }, { toolCallId: 'toolu_1', messages: [] });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.path, '/tools/bash');
  assert.equal(requests[0]!.opts.retry, false, 'the connection must not retry a tool call');
  assert.equal((requests[0]!.opts.headers as Record<string, string>)[TOOL_CALL_HEADER], 'toolu_1');
  // The refusal reaches the model as data; the api ran the call and filed it.
  assert.equal((answer as { error: { code: string } }).error.code, 'exec_timeout');
  assert.deepEqual(filed, ['toolu_1']);
  assert.equal(recorded.length, 0, 'nothing written yet — the step waits for its results');
});

test('an answer that completed the step carries what the api wrote', async () => {
  const written = { lines: [{ type: 'message', id: 'x', at: 'now', message: { role: 'tool', content: [] } }], count: 9, updated_at: 'now' };
  const { backend } = fakeBackend({ ok: true, data: { out: 'hi' }, record: written });
  const { ctx, recorded } = context(backend);
  const built = await serverToolKit(listing).build(ctx);
  const answer = await built.tools.bash!.execute!({ command: 'echo hi' }, { toolCallId: 'toolu_2', messages: [] });
  assert.deepEqual(answer, { ok: true, data: { out: 'hi' } }, 'the model never sees the record');
  assert.deepEqual(recorded, [written]);
});

test('a mutating tool refused while read-only never reaches the api, and is NOT filed — the turn must send that result', async () => {
  const { backend, requests } = fakeBackend({ ok: true });
  const { ctx, filed } = context(backend, true);
  const kits = new ToolKitSet();
  kits.add(serverToolKit(listing));
  const { tools, serverTools } = await kits.resolve(ctx);
  const answer = await tools.bash!.execute!({ command: 'rm -rf x' }, { toolCallId: 'toolu_3', messages: [] });
  assert.equal(requests.length, 0, 'nothing was sent');
  assert.equal((answer as { error: { code: string } }).error.code, 'readonly');
  assert.deepEqual(filed, []);
  assert.ok(serverTools.has('bash'));
});
