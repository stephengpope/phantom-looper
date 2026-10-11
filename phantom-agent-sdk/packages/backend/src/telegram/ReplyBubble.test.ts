// The reply bubble draws a turn into chat messages: dots taken over by the
// first output, a line per tool, thinking after a tool, the final text into
// the last slot. Run: npm test (tsx --test) in this package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyBubble } from './ReplyBubble.js';
import type { TelegramApi } from './TelegramApi.js';

type Call = { method: 'send' | 'edit' | 'delete'; id: number; text: string };

/** A chat that remembers every message and what it says now. */
function fakeApi(opts: { failEdits?: () => boolean } = {}) {
  const calls: Call[] = [];
  const messages = new Map<number, string>();
  let next = 1;
  const api = {
    async sendMessage(_chat: number, text: string) { const id = next++; messages.set(id, text); calls.push({ method: 'send', id, text }); return { message_id: id }; },
    async editMessageText(_chat: number, id: number, text: string) {
      if (opts.failEdits?.()) throw new Error('telegram editMessageText failed: Too Many Requests');
      messages.set(id, text); calls.push({ method: 'edit', id, text });
    },
    async deleteMessage(_chat: number, id: number) { messages.delete(id); calls.push({ method: 'delete', id, text: '' }); },
    async sendBytes() { throw new Error('no files in these tests'); },
  };
  return { api: api as unknown as TelegramApi, calls, messages };
}

const TICK = 20;
const settle = () => new Promise((wake) => setTimeout(wake, TICK * 3));

test('dots are taken by the first text; a tool gets its own line; thinking follows a result; the reply lands in the last slot', async () => {
  const { api, calls, messages } = fakeApi();
  const bubble = new ReplyBubble(api, 7, { tickMs: TICK });
  await settle();
  assert.equal(calls[0].method, 'send');
  const dots = calls[0].id;
  assert.ok(messages.get(dots)!.startsWith('...'), 'the wait is dots');
  assert.ok(calls.filter((call) => call.id === dots && call.method === 'edit').length >= 1, 'the dots move');

  bubble.part({ type: 'text-delta', text: 'Looking' });
  await settle();
  assert.equal(messages.get(dots), 'Looking', 'the first text took the dots message over');

  bubble.part({ type: 'tool-call', toolCallId: 'c1', toolName: 'bash' });
  bubble.part({ type: 'tool-input-start', id: 'c1', toolName: 'bash' });
  await settle();
  assert.equal(messages.size, 2, 'one line for one tool call, however many parts announce it');
  const toolLine = [...messages.keys()].find((id) => id !== dots)!;
  assert.equal(messages.get(toolLine), '⚙️ bash · 0s');

  bubble.part({ type: 'tool-result', toolCallId: 'c1' });
  await settle();
  assert.equal(messages.get(toolLine), '⚙️ bash ✓');
  assert.equal(messages.size, 3);
  const thinking = [...messages.keys()].find((id) => id !== dots && id !== toolLine)!;
  assert.ok(messages.get(thinking)!.startsWith('💭 thinking .'), 'thinking while the model reads the result');

  bubble.part({ type: 'text-delta', text: 'Done.' });
  await settle();
  assert.equal(messages.get(thinking), '💭 thinking ✓', 'the thinking line closes when the model talks');
  assert.equal(messages.size, 4, 'the next text is a new message below it');

  const said = await bubble.finish('Looking\n\nDone, all good.');
  assert.equal(said, 'Looking\n\nDone, all good.');
  const last = Math.max(...messages.keys());
  assert.equal(messages.get(last), 'Looking\n\nDone, all good.', 'the final text replaces the last segment');
  assert.equal(messages.size, 4, 'finish posts nothing extra');
});

test('a reply with no text takes its wait down; voice mode never types the text', async () => {
  const empty = fakeApi();
  const silent = new ReplyBubble(empty.api, 7, { tickMs: TICK });
  await settle();
  assert.equal(await silent.finish(''), '');
  assert.equal(empty.messages.size, 0, 'the dots are deleted');

  const voice = fakeApi();
  const spoken = new ReplyBubble(voice.api, 7, { tickMs: TICK, voiceOnly: true });
  spoken.part({ type: 'text-delta', text: 'Hello there' });
  await settle();
  assert.ok([...voice.messages.values()].every((text) => text.startsWith('...')), 'only the dots show');
  assert.equal(await spoken.finish('Hello there'), 'Hello there', 'the text comes back to be spoken');
  assert.equal(voice.messages.size, 0);
});

test('no placeholder: finish is one post, chunked; discard deletes a wait and keeps what was drawn', async () => {
  const one = fakeApi();
  const shot = new ReplyBubble(one.api, 7, { tickMs: TICK, placeholder: false });
  await settle();
  assert.equal(one.calls.length, 0, 'nothing is posted until there is something to say');
  await shot.finish('x'.repeat(5000));
  assert.equal(one.messages.size, 2, 'split under 4096');

  const dropped = fakeApi();
  const bubble = new ReplyBubble(dropped.api, 7, { tickMs: TICK });
  bubble.part({ type: 'tool-call', toolCallId: 'c1', toolName: 'read' });
  bubble.part({ type: 'tool-result', toolCallId: 'c1' });
  await settle();
  await bubble.discard();
  assert.deepEqual([...dropped.messages.values()], ['📖 read ✓'], 'the thinking wait is gone, the tool line stays');
});

test('a failed edit is corrected by the next tick', async () => {
  let failing = true;
  const { api, messages } = fakeApi({ failEdits: () => failing });
  const bubble = new ReplyBubble(api, 7, { tickMs: TICK });
  await settle();
  bubble.part({ type: 'text-delta', text: 'Hello' });
  await settle();
  assert.ok(messages.get(1)!.startsWith('...'), 'the edit failed, the dots are still up');
  failing = false;
  await settle();
  assert.equal(messages.get(1), 'Hello', 'the next tick caught up');
  await bubble.finish('Hello');
});
