// cursorAudit.ts: the audit asks after a quiet frame, stays silent while the
// terminal agrees with the mirror, calls drift the moment it does not, and
// switches itself off when the terminal never answers. The filter keeps the
// replies out of Ink's input while keys, mouse and partial chunks pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCursorAudit, createCprFilter, splitCpr, type CursorAt } from './cursorAudit.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rig(timing: { settleMs?: number; minIntervalMs?: number; timeoutMs?: number; maxMisses?: number } = {}) {
  const asked: number[] = [];
  const drifts: Array<[CursorAt, CursorAt]> = [];
  const logs: string[] = [];
  let at: CursorAt = { row: 10, col: 1 };
  const audit = createCursorAudit({
    ask: () => asked.push(Date.now()),
    expected: () => at,
    onDrift: (t, e) => drifts.push([t, e]),
    log: (l) => logs.push(l),
    ...timing,
  });
  return { audit, asked, drifts, logs, set: (a: CursorAt) => { at = a; } };
}

test('a frame arms one query after the settle, a matching reply stays silent', async () => {
  const { audit, asked, drifts } = rig({ settleMs: 10 });
  audit.frame();
  audit.frame(); // the burst re-arms, it does not stack
  await sleep(30);
  assert.equal(asked.length, 1);
  audit.reply(10, 1);
  await sleep(30);
  assert.equal(drifts.length, 0);
  assert.equal(asked.length, 1, 'no new query until the next frame');
});

test('a reply that disagrees with the mirror is a drift, with both positions logged', async () => {
  const { audit, drifts, logs } = rig({ settleMs: 1 });
  audit.frame();
  await sleep(20);
  audit.reply(11, 1); // the terminal wrapped one row the width math missed
  assert.deepEqual(drifts, [[{ row: 11, col: 1 }, { row: 10, col: 1 }]]);
  assert.match(logs[0], /11,1.*10,1.*drift/);
});

test('one query in flight at a time, and a terminal that never answers switches the audit off', async () => {
  const { audit, asked, logs } = rig({ settleMs: 1, minIntervalMs: 1, timeoutMs: 10, maxMisses: 3 });
  for (let i = 0; i < 3; i++) {
    audit.frame();
    await sleep(25); // arm, ask, miss
  }
  assert.equal(asked.length, 3);
  assert.equal(audit.off, true);
  assert.match(logs.at(-1)!, /never answers DSR/);
  audit.frame();
  await sleep(20);
  assert.equal(asked.length, 3, 'no more queries once off');
});

test('a reply with nothing pending is ignored — late or not ours', () => {
  const { audit, drifts } = rig();
  audit.reply(1, 1);
  assert.equal(drifts.length, 0);
});

test('splitCpr: replies out, text through, a partial tail held', () => {
  assert.deepEqual(splitCpr('abc\x1b[24;80Rdef'), { text: 'abcdef', hold: '', replies: [{ row: 24, col: 80 }] });
  assert.deepEqual(splitCpr('abc\x1b[24;8'), { text: 'abc', hold: '\x1b[24;8', replies: [] });
  assert.deepEqual(splitCpr('\x1b[24;80R'), { text: '', hold: '', replies: [{ row: 24, col: 80 }] });
  // Keys and mouse reports are never held: only digits and ';' may follow CSI.
  assert.deepEqual(splitCpr('\x1b[A'), { text: '\x1b[A', hold: '', replies: [] });
  assert.deepEqual(splitCpr('\x1b'), { text: '\x1b', hold: '', replies: [] });
  assert.deepEqual(splitCpr('\x1b[<64;10;5M'), { text: '\x1b[<64;10;5M', hold: '', replies: [] });
});

test('the filter strips replies for the audit and passes everything else to Ink, partials included', async () => {
  const source = new EventEmitter() as NodeJS.ReadStream;
  const cprs: CursorAt[] = [];
  const ink = createCprFilter(source, (at) => cprs.push(at), { holdMs: 50 });
  ink.setEncoding('utf8');
  const seen: string[] = [];
  ink.on('data', (d) => seen.push(String(d)));

  source.emit('data', 'type \x1b[24;8');           // a CPR split mid-sequence
  await sleep(20);
  assert.deepEqual(seen, ['type '], 'the partial is held, the text is through');
  source.emit('data', '0Rthis');                   // it completes
  assert.deepEqual(cprs, [{ row: 24, col: 80 }]);
  await sleep(20);
  assert.deepEqual(seen.join(''), 'type this', 'Ink never sees the reply');
  source.emit('data', '\x1b[<64;10;5M');           // the mouse rides through whole
  await sleep(20);
  assert.deepEqual(seen.join(''), 'type this\x1b[<64;10;5M');
});

test('a held partial that never completes flushes as plain input', async () => {
  const source = new EventEmitter() as NodeJS.ReadStream;
  const ink = createCprFilter(source, () => {}, { holdMs: 10 });
  const seen: string[] = [];
  ink.on('data', (d) => seen.push(String(d)));
  source.emit('data', '\x1b[24;');
  await sleep(30);
  assert.deepEqual(seen, ['\x1b[24;'], 'held input is never eaten');
});

test('the filter poses as the TTY Ink needs: raw mode and ref delegate', () => {
  const source = new EventEmitter() as NodeJS.ReadStream;
  const calls: string[] = [];
  source.setRawMode = (m: boolean) => { calls.push(`raw:${m}`); return source; };
  source.ref = () => { calls.push('ref'); return source; };
  source.unref = () => { calls.push('unref'); return source; };
  const ink = createCprFilter(source, () => {});
  assert.equal(ink.isTTY, true);
  ink.setRawMode(true); ink.ref(); ink.unref();
  assert.deepEqual(calls, ['raw:true', 'ref', 'unref']);
});
