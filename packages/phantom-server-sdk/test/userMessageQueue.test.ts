// The user message queue against an in-memory transcript.
// Run: npx tsx --test test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptLine } from 'phantom-client-sdk';
import { UserMessageQueue, MAX_PER_SESSION, type SessionAccess } from '../src/index.js';

class FakeStore implements SessionAccess {
  lines = new Map<string, TranscriptLine[]>();
  appends = 0;
  /** The next N writes fail. */
  failAppends = 0;

  async appendTranscript(id: string, lines: TranscriptLine[]): Promise<void> {
    this.appends++;
    if (this.failAppends > 0) { this.failAppends--; throw new Error('append failed'); }
    this.lines.set(id, [...(this.lines.get(id) ?? []), ...lines]);
  }
  texts(id: string): string[] {
    return (this.lines.get(id) ?? []).map((l) => (l.type === 'message' ? (l.message.content as string) : l.type));
  }
}

test('add queues; drain writes everything waiting as user messages, in order', async () => {
  const store = new FakeStore();
  const q = new UserMessageQueue(store);
  q.add('s1', 'sync: 2 files arrived');
  q.add('s1', 'task 3 exited 1');
  assert.deepEqual(store.texts('s1'), []);
  assert.deepEqual(q.pending('s1'), ['sync: 2 files arrived', 'task 3 exited 1']);
  assert.deepEqual(await q.drain('s1'), ['sync: 2 files arrived', 'task 3 exited 1']);
  assert.deepEqual(store.texts('s1'), ['sync: 2 files arrived', 'task 3 exited 1']);
  assert.deepEqual(q.pending('s1'), []);
  const line = store.lines.get('s1')![0]!;
  assert.equal(line.type, 'message');
  assert.equal((line as { message: { role: string } }).message.role, 'user');
  assert.ok(typeof line.id === 'string' && typeof line.at === 'string');
});

test('nothing waiting: drain writes nothing', async () => {
  const store = new FakeStore();
  const q = new UserMessageQueue(store);
  assert.deepEqual(await q.drain('s1'), []);
  assert.equal(store.appends, 0);
});

test('the same text already waiting is not queued twice', () => {
  const q = new UserMessageQueue(new FakeStore());
  q.add('s1', 'sync: nothing new');
  q.add('s1', 'sync: nothing new');
  assert.deepEqual(q.pending('s1'), ['sync: nothing new']);
});

test('a write that fails leaves the messages queued, in order, ahead of newer ones', async () => {
  const store = new FakeStore();
  const q = new UserMessageQueue(store);
  q.add('s1', 'first');
  store.failAppends = 1;
  await assert.rejects(q.drain('s1'), /append failed/);
  q.add('s1', 'second');
  assert.deepEqual(q.pending('s1'), ['first', 'second']);
  assert.deepEqual(await q.drain('s1'), ['first', 'second']);
  assert.deepEqual(store.texts('s1'), ['first', 'second']);
});

test('sessions are independent; the per-session cap drops the oldest', () => {
  const q = new UserMessageQueue(new FakeStore());
  for (let i = 0; i < MAX_PER_SESSION + 5; i++) q.add('a', `a${i}`);
  q.add('b', 'b0');
  assert.equal(q.pending('a').length, MAX_PER_SESSION);
  assert.equal(q.pending('a')[0], 'a5');
  assert.deepEqual(q.pending('b'), ['b0']);
});
