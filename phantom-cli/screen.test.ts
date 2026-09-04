// screen.ts: the mirror sees exactly what Ink wrote (after cursor moves and
// colours), reports the text under a selection, and paints the highlight
// after every frame in reverse video without touching the emulator's content.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createScreen } from './screen.js';

function fakeTty(columns = 40, rows = 6) {
  const writes: string[] = [];
  class Tty extends EventEmitter {
    isTTY = true;
    columns = columns;
    rows = rows;
    write = (s: string) => { writes.push(s); return true; };
  }
  return { tty: new Tty() as unknown as NodeJS.WriteStream, writes };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test('the mirror tees to the terminal and reads back the cells Ink painted', async () => {
  const { tty, writes } = fakeTty();
  const screen = createScreen(tty);
  screen.stream.write('\x1b[H\x1b[2Jhello \x1b[1mworld\x1b[0m  \n\x1b[2;3Hsecond line here\x1b[4;1Hlast');
  await flush();
  assert.equal(writes.length, 1, 'passed through once, verbatim');
  assert.deepEqual(screen.textOf([{ y: 0, x0: 0, x1: 10 }]), ['hello world']);
  assert.deepEqual(screen.textOf([{ y: 1, x0: 0, x1: 39 }]), ['  second line here'], 'cursor-positioned text, trailing blanks trimmed');
  assert.deepEqual(screen.textOf([{ y: 1, x0: 9, x1: 12 }, { y: 3, x0: 0, x1: 3 }]), ['line', 'last']);
  assert.deepEqual(screen.size(), { columns: 40, rows: 6 });
});

test('highlight paints reverse video over the selected cells after each frame, and clears', async () => {
  const { tty, writes } = fakeTty();
  const screen = createScreen(tty);
  screen.stream.write('\x1b[H\x1b[2Jabcdef\nghijkl');
  await flush();
  writes.length = 0;
  screen.highlight([{ y: 0, x0: 1, x1: 3 }]);
  const first = writes.join('');
  assert.match(first, /\x1b7/, 'saves the cursor');
  assert.match(first, /\x1b\[1;2H\x1b\[0;7mbcd\x1b\[0m/, 'row 1 col 2, reverse video, the cells\' own text');
  assert.match(first, /\x1b8$/, 'restores the cursor');
  // Ink paints a new frame: the highlight is re-applied on top of it.
  writes.length = 0;
  screen.stream.write('\x1b[H\x1b[2JABCDEF\nGHIJKL');
  await flush();
  assert.match(writes.join(''), /\x1b\[0;7mBCD\x1b\[0m/, 'repainted with the NEW text under the same cells');
  // Moving the highlight repaints the old cells plain, then the new ones inverted.
  writes.length = 0;
  screen.highlight([{ y: 1, x0: 0, x1: 1 }]);
  const moved = writes.join('');
  assert.match(moved, /\x1b\[1;2H\x1b\[0mBCD/, 'old cells back to plain');
  assert.match(moved, /\x1b\[2;1H\x1b\[0;7mGH\x1b\[0m/);
  // Off: old cells restored, nothing inverted.
  writes.length = 0;
  screen.highlight(null);
  assert.match(writes.join(''), /\x1b\[2;1H\x1b\[0mGH/);
  assert.ok(!/\[0;7m/.test(writes.join('')));
  assert.deepEqual(screen.textOf([{ y: 0, x0: 0, x1: 5 }]), ['ABCDEF'], 'the emulator never saw the overlay');
});

test('a resize reaches Ink through the mirror and resizes the emulator', async () => {
  const { tty } = fakeTty(40, 6);
  const screen = createScreen(tty);
  let resized = 0;
  (screen.stream as unknown as EventEmitter).on('resize', () => resized++);
  (tty as unknown as { columns: number; rows: number }).columns = 100;
  (tty as unknown as { columns: number; rows: number }).rows = 30;
  (tty as unknown as EventEmitter).emit('resize');
  assert.equal(resized, 1);
  assert.deepEqual(screen.size(), { columns: 100, rows: 30 });
});

test('the mirror replays incremental frames: Ink rewrites only changed lines in place (index.tsx turns that mode on)', async () => {
  const { tty } = fakeTty(40, 6);
  const screen = createScreen(tty);
  // A full first frame, then Ink's incremental update: cursor up to the top,
  // ESC[E past an unchanged line, rewrite one line at column 1 with ESC[K to
  // clear its tail, and nothing at all for an unchanged last line.
  screen.stream.write('\x1b[H\x1b[2Jalpha\nbravo old\ncharlie');
  await flush();
  screen.stream.write('\x1b[2A\x1b[E\x1b[1GBRAVO\x1b[K\n');
  await flush();
  assert.deepEqual(
    screen.textOf([{ y: 0, x0: 0, x1: 39 }, { y: 1, x0: 0, x1: 39 }, { y: 2, x0: 0, x1: 39 }]),
    ['alpha', 'BRAVO', 'charlie'],
    'the changed line replaced, its old tail erased, the others untouched');
  // The last line changes: two ESC[E hops, rewrite without a trailing newline.
  screen.stream.write('\x1b[2A\x1b[E\x1b[E\x1b[1Gdelta\x1b[K');
  await flush();
  assert.deepEqual(
    screen.textOf([{ y: 1, x0: 0, x1: 39 }, { y: 2, x0: 0, x1: 39 }]),
    ['BRAVO', 'delta']);
});

test('PHANTOM_CLI_TRACE_FRAMES records every frame with its raw bytes (the flight recorder)', async () => {
  const path = join(tmpdir(), `phantom-trace-${Date.now()}.log`);
  process.env.PHANTOM_CLI_TRACE_FRAMES = path;
  try {
    const { tty } = fakeTty(40, 6);
    const screen = createScreen(tty);
    screen.stream.write('\x1b[H\x1b[2Jhello\n');
    await flush();
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, 'frame');
    assert.ok(lines[0].raw.includes('hello'), 'the raw bytes are kept for replay');
    assert.equal(typeof lines[0].in, 'number');
    assert.equal(lines[0].clear, true);
  } finally { delete process.env.PHANTOM_CLI_TRACE_FRAMES; }
});
