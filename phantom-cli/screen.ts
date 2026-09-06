// A mirror of the screen. Ink writes its frames through this stream; the
// stream passes every byte to the real terminal AND to a headless terminal
// emulator (@xterm/headless — xterm.js without a DOM), so at any moment we
// can ask "what text is at these cells?" — exactly what the user sees, after
// Ink's wrapping, colours and incremental updates. That is what makes drag-
// to-select copy the right text: Ink does not expose its rendered frame, and
// re-deriving it from React state would be a second renderer that drifts.
//
// The same stream paints the selection highlight: cells in the selected
// ranges are redrawn in reverse video straight after each Ink write (Ink would
// otherwise paint over them on its next frame). Overlay writes go to the real
// terminal only — the emulator keeps the true content.
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.js';
import xterm from '@xterm/headless';
import { createTrim } from './trim.js';
import type { Range } from './mouse.js';

const { Terminal } = xterm;

/** The flight recorder: PHANTOM_CLI_TRACE_FRAMES=1 (or a path) records every
 *  write that reaches the real terminal — when, how big before and after
 *  trimming, how many rows it repaints, whether it is a full clear — plus the
 *  raw bytes, so a flicker seen in a real session can be replayed and named
 *  instead of guessed at. One JSON object per line; off unless asked for. */
function makeTracer(): ((e: Record<string, unknown>) => void) | null {
  const want = process.env.PHANTOM_CLI_TRACE_FRAMES;
  if (!want) return null;
  const path = want === '1' ? join(CONFIG_DIR, 'frames.log') : want;
  try { mkdirSync(join(path, '..'), { recursive: true }); } catch { /* exists */ }
  return (e) => {
    try { appendFileSync(path, `${JSON.stringify({ t: Date.now(), ...e })}\n`); }
    catch { /* the recorder must never take the screen down */ }
  };
}

export interface Screen {
  /** Hand this to Ink's `render()` as `stdout`. */
  stream: NodeJS.WriteStream;
  /** The text in these ranges, one string per row, trailing spaces trimmed. */
  textOf(ranges: Range[]): string[];
  /** Highlight these ranges (or none) — repainted after every Ink frame. */
  highlight(ranges: Range[] | null): void;
  /** Current size, as the emulator sees it. */
  size(): { columns: number; rows: number };
}

export function createScreen(real: NodeJS.WriteStream): Screen {
  const term = new Terminal({ cols: real.columns || 80, rows: real.rows || 24, allowProposedApi: true, scrollback: 0 });
  const trim = createTrim();
  const trace = makeTracer();
  let ranges: Range[] | null = null;
  let painted: Range[] | null = null;

  const cellText = (y: number, x0: number, x1: number): string => {
    const line = term.buffer.active.getLine(y);
    if (!line) return '';
    let out = '';
    for (let x = x0; x <= x1 && x < term.cols; x++) {
      const cell = line.getCell(x);
      const ch = cell?.getChars() ?? '';
      // A wide glyph occupies two cells; the second is empty — skip it.
      if (cell && cell.getWidth() === 0) continue;
      out += ch === '' ? ' ' : ch;
    }
    return out;
  };

  const paint = (): void => {
    // Put back what was highlighted (plain text — Ink's next frame restores
    // colours), then draw the current ranges in reverse video.
    let seq = '\x1b7';
    for (const r of painted ?? []) seq += `\x1b[${r.y + 1};${r.x0 + 1}H\x1b[0m${cellText(r.y, r.x0, r.x1)}`;
    for (const r of ranges ?? []) seq += `\x1b[${r.y + 1};${r.x0 + 1}H\x1b[0;7m${cellText(r.y, r.x0, r.x1)}\x1b[0m`;
    seq += '\x1b8';
    painted = ranges ? ranges.map((r) => ({ ...r })) : null;
    real.write(seq);
  };

  class Mirror extends EventEmitter {
    get isTTY(): boolean { return real.isTTY; }
    get columns(): number { return real.columns; }
    get rows(): number { return real.rows; }
    write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      // The real terminal gets the trimmed stream (trim.ts: a row rewrite
      // whose left part the row already holds starts at the first changed
      // column); the emulator gets the original — both land on the same
      // screen, and the emulator is the record of it.
      const sent = trim.write(s);
      trace?.({ kind: 'frame', in: s.length, out: sent.length,
        rows: (sent.match(/\x1b\[K/g) ?? []).length, clear: sent.includes('\x1b[2J'), raw: s });
      const ok = real.write(sent, ...(rest as []));
      // The tty driver turns "\n" into "\r\n" on the way to the real terminal
      // (ONLCR — raw mode only changes input); the emulator is a bare terminal,
      // so do the same or everything after a newline lands mid-row.
      // It parses asynchronously: repaint the highlight from ITS callback, or
      // the overlay is drawn with the previous frame's text.
      term.write(s.replace(/\r?\n/g, '\r\n'), () => { if (ranges && ranges.length) paint(); });
      return ok;
    };
  }
  const mirror = new Mirror();
  const onResize = (): void => {
    term.resize(real.columns || 80, real.rows || 24);
    trim.reset();
    trace?.({ kind: 'resize', columns: real.columns, rows: real.rows });
    mirror.emit('resize');
  };
  real.on('resize', onResize);

  return {
    stream: mirror as unknown as NodeJS.WriteStream,
    textOf: (rs) => rs.map((r) => cellText(r.y, r.x0, r.x1).replace(/\s+$/, '')),
    highlight: (rs) => {
      ranges = rs && rs.length ? rs : null;
      if (ranges || painted) paint();
    },
    size: () => ({ columns: term.cols, rows: term.rows }),
  };
}
