// The server tool kit against a fake backend: a tool call is POSTed once,
// never under the connection's retry rule — a 5xx (a timed-out command) is
// the model's to act on, not the transport's to repeat. Run: npm test
// (tsx --test) in this package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverToolKit, TOOL_CALL_HEADER, type ToolKitContext } from './toolkit.js';
import type { BackendClient } from './backend.js';

test('a server tool call is sent once: retry off, the call id in its header', async () => {
  const requests: Array<{ method: string; path: string; body: unknown; opts: Record<string, unknown> }> = [];
  const backend = {
    callRaw: async (method: string, path: string, body: unknown, opts: Record<string, unknown>) => {
      requests.push({ method, path, body, opts });
      return { ok: false, error: { code: 'exec_timeout', message: 'killed after 240000ms', retryable: true } };
    },
  } as unknown as BackendClient;
  const recorded: unknown[] = [];
  const ctx: ToolKitContext = {
    backend, sessionId: 's1', projectId: 'p1', workspaceId: 'w1', readonly: () => false,
    recorded: (written) => recorded.push(written),
  };
  const built = await serverToolKit([{ name: 'bash', summary: 'run', description: 'run a command', input: { type: 'object' }, mutates: true }]).build(ctx);
  const answer = await built.tools.bash!.execute!({ command: 'sleep 999' }, { toolCallId: 'toolu_1', messages: [] });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.path, '/tools/bash');
  assert.equal(requests[0]!.opts.retry, false, 'the connection must not retry a tool call');
  assert.equal((requests[0]!.opts.headers as Record<string, string>)[TOOL_CALL_HEADER], 'toolu_1');
  // The refusal reaches the model as data; nothing was filed as recorded.
  assert.equal((answer as { error: { code: string } }).error.code, 'exec_timeout');
  assert.equal(recorded.length, 0);
});
