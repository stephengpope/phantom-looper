// The user message queue against an in-memory session store with a lock.
// Run: npx tsx --test test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptLine } from 'phantom-client-sdk';
import { UserMessageQueue, MAX_PER_SESSION, type SessionAccess } from '../src/index.js';

/** One session store: a lock and a transcript. `failAppends` makes the next
 *  N writes fail. */
class FakeStore implements SessionAccess {
  lockedBy = new Map<string, string>();
  lines = new Map<string, TranscriptLine[]>();
  calls: string[] = [];
  failAppends = 0;

  async tryLock(id: string): Promise<boolean> {
    this.calls.push(`lock ${id}`);
    if (this.lockedBy.has(id)) return false;
    this.lockedBy.set(id, 'queue');
    return true;
  }
  /** Runs while a release is in flight, before the lock is dropped. */
  duringRelease: (() => Promise<void>) | null = null;
  async releaseLock(id: string): Promise<void> {
    this.calls.push(`release ${id}`);
    const hook = this.duringRelease; this.duringRelease = null;
    if (hook) await hook();
    this.lockedBy.delete(id);
  }
  async appendTranscript(id: string, lines: TranscriptLine[]): Promise<void> {
    this.calls.push(`append ${id} ${lines.length}`);
    if (this.failAppends > 0) { this.failAppends--; throw new Error('append failed'); }
    assert.ok(this.lockedBy.has(id), 'a write without the lock');
    this.lines.set(id, [...(this.lines.get(id) ?? []), ...lines]);
  }
  texts(id: string): string[] {
    return (this.lines.get(id) ?? []).map((l) => (l.type === 'message' ? (l.message.content as string) : l.type));
  }
}

test('lock free: add takes the lock, writes one user message, releases', async () => {
  const store = new FakeStore();
  const q = new UserMessageQueue(store);
  await q.add('s1', 'task 7 exited 0');
  assert.deepEqual(store.texts('s1'), ['task 7 exited 0']);
  assert.deepEqual(store.calls, ['lock s1', 'append s1 1', 'release s1']);
  assert.deepEqual(q.pending('s1'), []);
  const line = store.lines.get('s1')![0]!;
  assert.equal(line.type, 'message');
  assert.equal((line as { message: { role: string } }).message.role, 'user');
});

test('lock held: the message waits; the holder ends its turn through release, which writes first', async () => {
  const store = new FakeStore();
  store.lockedBy.set('s1', 'cli-window');
  const q = new UserMessageQueue(store);
  await q.add('s1', 'sync: 2 files arrived');
  await q.add('s1', 'task 3 exited 1');
  assert.deepEqual(store.texts('s1'), []);
  assert.deepEqual(q.pending('s1'), ['sync: 2 files arrived', 'task 3 exited 1']);
  store.calls = [];
  await q.release('s1');
  assert.deepEqual(store.calls, ['append s1 2', 'release s1']);
  assert.deepEqual(store.texts('s1'), ['sync: 2 files arrived', 'task 3 exited 1']);
  assert.deepEqual(q.pending('s1'), []);
  assert.equal(store.lockedBy.has('s1'), false);
});

test('a message arriving while the lock is being released is written right after, under a fresh lock', async () => {
  const store = new FakeStore();
  store.lockedBy.set('s1', 'cli-window');
  const q = new UserMessageQueue(store);
  await q.add('s1', 'before');
  // Lands mid-release: after the write, before the lock is dropped.
  store.duringRelease = () => q.add('s1', 'during');
  await q.release('s1');
  assert.deepEqual(store.texts('s1'), ['before', 'during']);
  assert.deepEqual(q.pending('s1'), []);
  assert.equal(store.lockedBy.has('s1'), false);
  assert.deepEqual(store.calls,
    ['lock s1', 'append s1 1', 'release s1', 'lock s1', 'lock s1', 'append s1 1', 'release s1']);
});

test('a failed write still releases the lock; the messages stay queued', async () => {
  const store = new FakeStore();
  store.lockedBy.set('s1', 'cli-window');
  const q = new UserMessageQueue(store);
  await q.add('s1', 'first');
  store.failAppends = 2;   // the write in release, and the retry after it
  await assert.rejects(q.release('s1'), /append failed/);
  assert.equal(store.lockedBy.has('s1'), false);
  assert.deepEqual(q.pending('s1'), ['first']);
});

test('the same text already waiting is not queued twice', async () => {
  const store = new FakeStore();
  store.lockedBy.set('s1', 'cli-window');
  const q = new UserMessageQueue(store);
  await q.add('s1', 'sync: nothing new');
  await q.add('s1', 'sync: nothing new');
  assert.deepEqual(q.pending('s1'), ['sync: nothing new']);
});

test('a write that fails leaves the messages queued, in order, ahead of newer ones', async () => {
  const store = new FakeStore();
  store.lockedBy.set('s1', 'cli-window');
  const q = new UserMessageQueue(store);
  await q.add('s1', 'first');
  store.failAppends = 1;
  await assert.rejects(q.flush('s1'), /append failed/);
  await q.add('s1', 'second');
  assert.deepEqual(q.pending('s1'), ['first', 'second']);
  assert.deepEqual(await q.flush('s1'), ['first', 'second']);
  assert.deepEqual(store.texts('s1'), ['first', 'second']);
});

test('nothing waiting: flush writes nothing and add does not touch the lock', async () => {
  const store = new FakeStore();
  const q = new UserMessageQueue(store);
  assert.deepEqual(await q.flush('s1'), []);
  assert.deepEqual(store.calls, []);
});

test('sessions are independent; the per-session cap drops the oldest', async () => {
  const store = new FakeStore();
  store.lockedBy.set('a', 'x');
  store.lockedBy.set('b', 'y');
  const q = new UserMessageQueue(store);
  for (let i = 0; i < MAX_PER_SESSION + 5; i++) await q.add('a', `a${i}`);
  await q.add('b', 'b0');
  assert.equal(q.pending('a').length, MAX_PER_SESSION);
  assert.equal(q.pending('a')[0], 'a5');
  assert.deepEqual(q.pending('b'), ['b0']);
});
