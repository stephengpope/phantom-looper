// A Telegram call that hangs fails at its deadline instead of holding
// everything chained behind it (a bubble's edits) for as long as the socket
// lives. Run: npm test (tsx --test) in this package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramApi } from './TelegramApi.js';

test('a call with no answer fails at the deadline', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted at the deadline')));
  });
  // AbortSignal.timeout's timer does not keep the loop alive on its own; the
  // server always has other work running, this test holds the loop open.
  const keep = setTimeout(() => undefined, 5_000);
  try {
    const api = new TelegramApi('token', undefined, undefined, { timeoutMs: 200 });
    const started = Date.now();
    await assert.rejects(api.call('sendMessage', { chat_id: 1, text: 'x' }));
    assert.ok(Date.now() - started < 2_000, 'failed at the deadline, not later');
  } finally { clearTimeout(keep); globalThis.fetch = realFetch; }
});
