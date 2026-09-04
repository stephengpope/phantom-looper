// trim.ts: whatever the filter emits must land the terminal on EXACTLY the
// screen the original bytes would have — glyphs, widths and colours — while
// skipping the unchanged left part of every row Ink rewrites. Every test
// replays original and trimmed streams into two emulators and compares every
// cell; the interesting ones then assert the trim actually happened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import xterm from '@xterm/headless';
import { createTrim } from './trim.js';
import { createScreen } from './screen.js';

const { Terminal } = xterm;

/** The full screen as one comparable string: every cell's glyph, width and
 *  styling. The tty driver's \n→\r\n is mirrored here as screen.ts does. */
async function screenOf(chunks: string[], cols = 40, rows = 6): Promise<string> {
  const t = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  for (const c of chunks) await new Promise<void>((r) => { t.write(c.replace(/\r?\n/g, '\r\n'), r); });
  const out: string[] = [];
  for (let y = 0; y < rows; y++) {
    const line = t.buffer.active.getLine(y);
    for (let x = 0; x < cols; x++) {
      const cell = line?.getCell(x);
      if (!cell) { out.push('-'); continue; }
      out.push([cell.getChars(), cell.getWidth(), cell.getFgColor(), cell.getBgColor(),
        Number(cell.isBold()), Number(cell.isDim()), Number(cell.isItalic()),
        Number(cell.isUnderline()), Number(cell.isInverse())].join(','));
    }
    out.push('|');
  }
  return out.join(';');
}

/** Trim the chunks and prove both streams paint the same screen. */
async function equivalent(chunks: string[], cols = 40, rows = 6): Promise<string[]> {
  const trim = createTrim();
  const trimmed = chunks.map((c) => trim.write(c));
  assert.equal(await screenOf(trimmed, cols, rows), await screenOf(chunks, cols, rows),
    'trimmed stream must land on the identical screen');
  return trimmed;
}

// Frames the way Ink writes them: clearTerminal + full paint first, then
// cursor up + per-row rewrites (\x1b[1G text \x1b[K) with \x1b[E over
// unchanged rows.
const FIRST = '\x1b[2J\x1b[3J\x1b[Hleft pane text here │ right A\nsecond row of chat │ right B\nthird row sits here │ right C';

test('a rewrite that only changes the right half starts at the first changed column', async () => {
  const update = '\x1b[2A\x1b[1Gleft pane text here │ right CHANGED\x1b[K\x1b[E\x1b[E';
  const [, trimmed] = await equivalent([FIRST, update]);
  assert.ok(!trimmed.includes('left pane'), 'the unchanged left half is not resent');
  assert.match(trimmed, /\x1b\[2[0-9]G/, 'the cursor jumps into the right half');
  assert.ok(trimmed.length < update.length, 'and the frame got smaller');
});

test('styles in the skipped part are replayed, so the tail keeps its colours', async () => {
  const first = '\x1b[2J\x1b[3J\x1b[H\x1b[36mcyan left\x1b[39m plain middle \x1b[1mtail one\x1b[22m\nrow two';
  const update = '\x1b[1A\x1b[1G\x1b[36mcyan left\x1b[39m plain middle \x1b[1mtail TWO\x1b[22m\x1b[K\x1b[E';
  const [, trimmed] = await equivalent([first, update]);
  assert.ok(!trimmed.includes('cyan left'), 'the styled prefix is skipped');
  assert.ok(trimmed.includes('\x1b[36m') && trimmed.includes('\x1b[39m'), 'but its colour codes are replayed');
});

test('an identical rewrite sends a cursor move, not the row', async () => {
  const update = '\x1b[2A\x1b[1Gleft pane text here │ right A\x1b[K\x1b[E\x1b[E';
  const [, trimmed] = await equivalent([FIRST, update]);
  assert.ok(!trimmed.includes('left pane'), 'nothing of the row is resent');
});

test('a boundary never splits a wide glyph', async () => {
  const first = '\x1b[2J\x1b[3J\x1b[H好好好好好 tail A\nrow two';
  const update = '\x1b[1A\x1b[1G好好好好好 tail B\x1b[K\x1b[E';
  const [, trimmed] = await equivalent([first, update]);
  assert.ok(!trimmed.includes('好'), 'the wide prefix is skipped whole');
  // Five wide glyphs are ten columns, ' tail ' six more: the shared prefix
  // ends at column 16 and the cursor lands one past it.
  assert.match(trimmed, /\x1b\[17G/, 'the cursor counts wide glyphs as two columns');
});

test('a short shared prefix is not worth trimming and passes through', async () => {
  const first = '\x1b[2J\x1b[3J\x1b[Hab cdefgh\nrow two';
  const update = '\x1b[1A\x1b[1Gab XXXXXX\x1b[K\x1b[E';
  const [, trimmed] = await equivalent([first, update]);
  assert.ok(trimmed.includes('ab XXXXXX'), 'sent whole');
});

test('a row whose entering style was left dirty is never trimmed', async () => {
  // The first frame leaves bold open across the row boundary: byte-identical
  // prefixes would render differently, so the filter must resend in full.
  const first = '\x1b[2J\x1b[3J\x1b[H\x1b[1mbold left open still going\nsecond row shared prefix tail A';
  const update = '\x1b[1A\x1b[1Gsecond row shared prefix tail B\x1b[K\x1b[E';
  const [, trimmed] = await equivalent([first, update]);
  assert.ok(trimmed.includes('second row shared prefix'), 'resent whole');
});

test('erased rows are forgotten: a rewrite after eraseLines is sent whole', async () => {
  const shrink = '\x1b[2K\x1b[1A\x1b[2K\x1b[G';
  const rewrite = 'left pane text here │ right D\x1b[K';
  const [, , trimmed] = await equivalent([FIRST, shrink, rewrite]);
  assert.ok(trimmed.includes('left pane text here'), 'no stale memory of the erased row');
});

test('an escape the filter does not model passes through verbatim and drops its memory', async () => {
  const trim = createTrim();
  trim.write(FIRST);
  const osc = '\x1b]0;a title\x07\x1b[2A\x1b[1Gleft pane text here │ right E\x1b[K';
  assert.equal(trim.write(osc), osc, 'verbatim from the unknown escape on');
});

test('frames split across writes (bsu / frame / esu) trim the same', async () => {
  const update = '\x1b[2A\x1b[1Gleft pane text here │ right F\x1b[K\x1b[E\x1b[E';
  const trimmed = await equivalent(['\x1b[?2026h', FIRST, '\x1b[?2026l', '\x1b[?2026h', update, '\x1b[?2026l']);
  assert.ok(!trimmed[4].includes('left pane'), 'trimmed across chunk boundaries');
});

test('Ink never sends an absolute cursor address: relative tracking alone must trim', async () => {
  // A real Ink session opens with plain rows (no \x1b[2J, no \x1b[H — the
  // capture that proved it is in the git history of this test) and navigates
  // with cursor-up and next-line only. The filter anchors row zero itself;
  // waiting for an absolute address means never trimming at all.
  const first = 'left pane one │ right A\nleft pane two │ right B\nleft pane three │ right C';
  const update = '\x1b[2A\x1b[1Gleft pane one │ right CHANGED\x1b[K\x1b[E\x1b[E';
  const [, trimmed] = await equivalent([first, update]);
  assert.ok(!trimmed.includes('left pane'), 'trimmed without ever seeing an absolute address');
});

test('through the mirror: the terminal receives the trimmed bytes, the record keeps the originals', async () => {
  const writes: string[] = [];
  class Tty extends EventEmitter {
    isTTY = true; columns = 40; rows = 6;
    write = (s: string) => { writes.push(s); return true; };
  }
  const screen = createScreen(new Tty() as unknown as NodeJS.WriteStream);
  screen.stream.write(FIRST);
  await new Promise((r) => setTimeout(r, 20));
  screen.stream.write('\x1b[2A\x1b[1Gleft pane text here │ right NEW\x1b[K\x1b[E\x1b[E');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!writes[1].includes('left pane'), 'the tty was spared the unchanged half');
  assert.deepEqual(screen.textOf([{ y: 0, x0: 0, x1: 39 }]), ['left pane text here │ right NEW'],
    'while the mirror still reads the full row');
});
