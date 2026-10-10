// Link against a fake backend: the relay never drops a send — a failed POST
// waits and goes again, in order — and the feed follows through drops with
// a refill between. Run: npm test (tsx --test) in this package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Link, followStream } from './link.js';
import type { BackendClient } from './backend.js';

const tick = (ms = 0) => new Promise((wake) => setTimeout(wake, ms));

/** A backend whose POSTs fail `failures` times, then land; whose stream
 *  hands out the records given per connect. */
function fakeBackend(opts: { failures: number }) {
  const posted: unknown[][] = [];
  let failures = opts.failures;
  let connects = 0;
  const backend = {
    call: async (_method: string, _path: string, body: { events: unknown[] }) => {
      if (failures > 0) { failures--; throw Object.assign(new Error('unreachable'), { status: undefined }); }
      posted.push(body.events);
      return {};
    },
    stream: async function* () { connects++; yield { event: 'heartbeat' }; },
  } as unknown as BackendClient;
  return { backend, posted, connects: () => connects };
}

test('send: batched, ordered, retried until it lands', async () => {
  const { backend, posted } = fakeBackend({ failures: 2 });
  const link = new Link(backend, { feed: '/x', relay: '/y', onRecord: () => {} });
  link.send({ n: 1 });
  link.send({ n: 2 });
  await tick(200);                 // first flush: fails twice (1 s + 2 s backoff) — nothing landed yet
  assert.equal(posted.length, 0);
  link.send({ n: 3 });
  await link.drain();
  assert.deepEqual(posted.flat(), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  link.close();
});

test('close drops what is queued, and nothing after', async () => {
  const { backend, posted } = fakeBackend({ failures: 100 });
  const link = new Link(backend, { feed: '/x', relay: '/y', onRecord: () => {} });
  link.send({ n: 1 });
  link.close();
  link.send({ n: 2 });
  await tick(50);
  assert.equal(posted.length, 0);
  assert.equal(link.closed, true);
});

test('followStream: a drop reconnects with a refill first; status flips', async () => {
  let opened = 0;
  const seen: string[] = [];
  const stream = async (_path: string, _signal: AbortSignal) => {
    opened++;
    const n = opened;
    return (async function* () { yield { event: `r${n}` }; })();   // one record, then the server hangs up
  };
  const abort = new AbortController();
  const done = followStream(stream, '/feed', abort.signal, {
    onRecord: (rec) => { seen.push(String(rec.event)); },
    onReconnect: () => { seen.push('refill'); },
    onStatus: (up) => { seen.push(up ? 'up' : 'down'); },
  });
  await tick(1_300);               // the first link, a 1 s backoff, the second
  abort.abort();
  await done;
  assert.deepEqual(seen.slice(0, 6), ['up', 'r1', 'down', 'refill', 'up', 'r2']);
});
