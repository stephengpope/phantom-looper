// RemoteHost against a fake link: jobs go down a writer, events come back
// through deliver(). The rules under test are the ones that matter when the
// link is not there: a job for an offline host waits and goes on attach; a
// reconnect (same boot) re-sends what is unfinished; a RESTART (new boot)
// fails it with host_restarted; a stream's early consumer cancels the job.
// Run: npm test (tsx --test, node's runner) in this package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteHost } from './RemoteHost.js';
import type { Job } from '../host/protocol.js';
import { encodeError } from '../host/protocol.js';

const tick = () => new Promise((wake) => setImmediate(wake));

function wired() {
  const host = new RemoteHost('h1', 'laptop');
  const sent: Job[] = [];
  const writer = (job: Job) => { sent.push(job); };
  return { host, sent, writer };
}

test('offline: a job waits, goes down on attach, answers on deliver', async () => {
  const { host, sent, writer } = wired();
  assert.equal(host.online, false);
  const answer = host.containerState('ws1');
  await tick();
  assert.equal(sent.length, 0);                       // nowhere to send it yet
  host.attach('boot-1', writer);
  assert.equal(host.online, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'containerState');
  host.deliver([{ job: sent[0].id, type: 'result', value: 'running' }]);
  assert.equal(await answer, 'running');
});

test('reconnect with the same boot re-sends what is unfinished, once each', async () => {
  const { host, sent, writer } = wired();
  host.attach('boot-1', writer);
  const answer = host.repo('ws1').git(['status']);
  assert.equal(sent.length, 1);
  host.unlink(writer);
  assert.equal(host.online, false);
  const again: Job[] = [];
  host.attach('boot-1', (job) => { again.push(job); });
  assert.deepEqual(again.map((job) => job.id), [sent[0].id]);
  host.deliver([{ job: sent[0].id, type: 'result', value: { stdout: 'clean', stderr: '' } }]);
  assert.deepEqual(await answer, { stdout: 'clean', stderr: '' });
});

test('a new boot fails the jobs in flight with host_restarted', async () => {
  const { host, writer } = wired();
  host.attach('boot-1', writer);
  const answer = host.files('ws1').read('scratch/a.txt');
  host.unlink(writer);
  host.attach('boot-2', writer);
  await assert.rejects(answer, (error: Error & { code?: string; retryable?: boolean }) => error.code === 'host_restarted' && error.retryable === true);
});

test('an error carries git\'s own fields back', async () => {
  const { host, sent, writer } = wired();
  host.attach('boot-1', writer);
  const answer = host.repo('ws1').git(['push']);
  const failure = Object.assign(new Error('git: rejected'), { stderr: '! [rejected] non-fast-forward', code: 1 });
  host.deliver([{ job: sent[0].id, type: 'error', ...encodeError(failure) }]);
  await assert.rejects(answer, (error: Error & { stderr?: string; code?: unknown }) =>
    error.message === 'git: rejected' && error.stderr === '! [rejected] non-fast-forward' && error.code === 1);
});

test('a stream yields chunks in order and ends; stopping early cancels the job', async () => {
  const { host, sent, writer } = wired();
  host.attach('boot-1', writer);
  const records: unknown[] = [];
  const stream = host.sandbox('ws1').runStream(['sh']);
  const first = stream.next();
  await tick();
  const job = sent[0];
  assert.equal(job.kind, 'execStream');
  host.deliver([{ job: job.id, type: 'chunk', value: { seq: 0, data: 'a' } }, { job: job.id, type: 'chunk', value: { seq: 1, data: 'b' } }]);
  records.push((await first).value);
  records.push((await stream.next()).value);
  assert.deepEqual(records, [{ seq: 0, data: 'a' }, { seq: 1, data: 'b' }]);
  await stream.return(undefined);                      // the consumer stops
  assert.equal(sent.at(-1)!.kind, 'cancel');
  assert.equal((sent.at(-1) as { job?: string }).job, job.id);

  // A stream that ends on its own: end closes it.
  const whole = host.sandbox('ws1').runStream(['sh']);
  const p = whole.next();
  await tick();
  const job2 = sent.find((one) => one.kind === 'execStream' && one.id !== job.id)!;
  host.deliver([{ job: job2.id, type: 'chunk', value: { seq: 0, event: 'exit', code: 0 } }, { job: job2.id, type: 'end' }]);
  assert.deepEqual((await p).value, { seq: 0, event: 'exit', code: 0 });
  assert.equal((await whole.next()).done, true);
});

test('a watch is a standing order: re-sent on attach, its chunks fire the callback, unwatch ends it', () => {
  const { host, sent, writer } = wired();
  let changes = 0;
  host.watch('ws1', () => { changes++; });
  assert.equal(sent.length, 0);                       // offline: held
  host.attach('boot-1', writer);
  assert.equal(sent.filter((job) => job.kind === 'watch').length, 1);
  const watch = sent.find((job) => job.kind === 'watch')!;
  host.deliver([{ job: watch.id, type: 'chunk', value: { changed: true } }]);
  assert.equal(changes, 1);
  host.unlink(writer);
  host.attach('boot-1', writer);
  assert.equal(sent.filter((job) => job.kind === 'watch').length, 2);   // re-sent whole
  host.unwatch('ws1');
  assert.equal(sent.at(-1)!.kind, 'unwatch');
});

test('activeWorkspaces reads as none while offline — never a wait', async () => {
  const { host } = wired();
  assert.deepEqual(await host.activeWorkspaces(), []);
});
