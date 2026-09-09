// The interrupt record is THE stop signal: whoever runs a turn on the session
// hears it on the feed and aborts its own turn. This window runs a turn on
// the session it follows, so the feed's job is one delegation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionFeed } from './sessionFeed.js';
import type { Stream } from './follow.js';

test('an interrupt record on the feed aborts this window\'s turn on the session', async () => {
  const aborted: string[] = [];
  const store = {
    abortTurn: (id: string) => { aborted.push(id); },
    remoteEnd: () => {},
  };
  const stream: Stream = async () => (async function* () { yield { event: 'interrupt' }; })();
  const feed = new SessionFeed(stream, 's1', store as never, { onRecordLanded: () => {} });
  feed.start();
  await new Promise((r) => setTimeout(r, 50));
  feed.stop();
  assert.ok(aborted.includes('s1'), 'the feed hands the stop signal to the store');
});

test('an interrupt with no turn of ours running is a harmless no-op', async () => {
  // The store's abortTurn is the no-op (no abort controller); the feed must
  // not throw and must leave the rest of the feed alone.
  const store = {
    abortTurn: () => {},
    remoteEnd: () => {},
    remoteStart: () => { throw new Error('nothing started'); },
  };
  const stream: Stream = async () => (async function* () {
    yield { event: 'interrupt' };
    yield { event: 'heartbeat' };
  })();
  const feed = new SessionFeed(stream, 's1', store as never, { onRecordLanded: () => {} });
  feed.start();
  await new Promise((r) => setTimeout(r, 50));
  feed.stop();
});
