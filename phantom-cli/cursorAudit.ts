// The screen-integrity audit: after Ink writes a frame, ask the terminal
// where its cursor ACTUALLY is (DSR, `\x1b[6n` — the same cursor-position
// report ucs-detect measures terminals with) and compare it with where the
// screen mirror's emulator knows the frame left it. Ink's incremental
// renderer moves the cursor RELATIVELY (up N rows, rewrite), so one row the
// terminal wrapped that Ink's width math did not — the tab in a tool result,
// a glyph the font draws wide — leaves every later frame one row off, and it
// stays off until something forces a full repaint. The audit is the runtime
// version of "measure the terminal, never trust a width table": cheap while
// the screen is healthy (one 4-byte query after a burst of frames), and the
// moment the two cursors disagree it asks for a full repaint — the same
// collapse-a-frame path a resize takes — before the drift is visible for
// long. Claude Code's fullscreen renderer gets the same property by
// addressing every frame absolutely; this is how an Ink app gets it.
//
// The reply arrives on stdin as `\x1b[{row};{col}R`. Ink's useInput would
// hand it to every handler as typed text (the mouse-report problem all over
// again), so the reply is filtered OUT of the stream Ink sees — one place,
// here — by a PassThrough that stands between process.stdin and Ink and
// poses as the TTY (Ink's documented custom-stdin path).
import { PassThrough } from 'node:stream';

export interface CursorAt { row: number; col: number } // 1-based, as the terminal reports

export function createCursorAudit({ ask, expected, onDrift, log,
  settleMs = 750, minIntervalMs = 2000, timeoutMs = 800, maxMisses = 3 }: {
  /** Write the DSR query. */ ask: () => void;
  /** Where the screen mirror's cursor sits after the frame. */
  expected: () => CursorAt;
  /** The terminal's cursor and the mirror's disagree — repaint everything. */
  onDrift: (terminal: CursorAt, mirror: CursorAt) => void;
  /** One line for cli.log — the forensic trail when a drift is caught. */
  log: (line: string) => void;
  /** Quiet time after the last frame before asking; the closest two queries
   *  may sit; reply deadline; how many unanswered queries mean this terminal
   *  does not play (a multiplexer swallowing DSR) and the audit switches
   *  itself off rather than ask forever. */
  settleMs?: number; minIntervalMs?: number; timeoutMs?: number; maxMisses?: number;
}) {
  let pending: { want: CursorAt; deadline: NodeJS.Timeout } | null = null;
  let settle: NodeJS.Timeout | null = null;
  let lastAsk = 0;
  let misses = 0;
  let off = false;

  const query = (): void => {
    settle = null;
    if (off || pending) return;
    lastAsk = Date.now();
    const want = expected();
    const deadline = setTimeout(() => {
      pending = null;
      if (++misses >= maxMisses) { off = true; log('cursor audit: the terminal never answers DSR — audit off'); }
    }, timeoutMs);
    deadline.unref();
    pending = { want, deadline };
    ask();
  };

  return {
    /** Ink wrote a frame — arm the next audit. */
    frame(): void {
      if (off || pending) return;
      if (settle) clearTimeout(settle);
      // No closer than minInterval to the last query: a streaming turn paints
      // frames for minutes, and the audit's job is drift, not traffic.
      const wait = Math.max(settleMs, minIntervalMs - (Date.now() - lastAsk));
      settle = setTimeout(query, wait);
      settle.unref();
    },
    /** A cursor-position reply came in (row, col, 1-based). */
    reply(row: number, col: number): void {
      if (!pending) return; // late, or not ours
      clearTimeout(pending.deadline);
      const want = pending.want;
      pending = null;
      misses = 0;
      if (row === want.row && col === want.col) return;
      log(`cursor audit: terminal at ${row},${col} but the frame left the cursor at ${want.row},${want.col} — drift, repainting`);
      onDrift({ row, col }, want);
    },
    /** The app is going away: never ask again, and say whether a query is
     *  still in flight — its reply arrives after we are gone unless the
     *  caller lingers to swallow it (a reply that lands after the process
     *  exits is typed into the user's shell: `^[[41;1R` at the prompt). */
    stop(): boolean {
      off = true;
      if (settle) { clearTimeout(settle); settle = null; }
      if (!pending) return false;
      clearTimeout(pending.deadline);
      pending = null;
      return true;
    },
    get off(): boolean { return off; },
  };
}

const CPR = /^\x1b\[(\d+);(\d+)R/;
/** Still able to grow into a CPR: ESC [ then only digits and semicolons. */
const CPR_PARTIAL = /^\x1b\[[\d;]*$/;

/** Split a chunk into the text Ink should see, the CPRs to route to the
 *  audit, and a held tail that may yet complete a CPR on the next chunk. */
export function splitCpr(data: string): { text: string; hold: string; replies: CursorAt[] } {
  const replies: CursorAt[] = [];
  let text = '';
  let i = 0;
  while (i < data.length) {
    if (data[i] === '\x1b') {
      const tail = data.slice(i);
      const m = CPR.exec(tail);
      if (m) { replies.push({ row: Number(m[1]), col: Number(m[2]) }); i += m[0].length; continue; }
      if (CPR_PARTIAL.test(tail)) return { text, hold: tail, replies };
    }
    text += data[i++];
  }
  return { text, hold: '', replies };
}

/** process.stdin, minus the cursor-position replies: they are the audit's,
 *  not the user's. Everything else — keys, mouse reports, pasted text —
 *  flows through untouched; a held partial flushes after `holdMs` so a lone
 *  truncated sequence can never eat input. Ink needs a TTY shape (its
 *  documented custom stdin), so raw mode and ref delegate to the real one. */
export function createCprFilter(stdin: NodeJS.ReadStream, onCpr: (at: CursorAt) => void,
  { holdMs = 25 }: { holdMs?: number } = {}): NodeJS.ReadStream {
  const pt = new PassThrough();
  let hold = '';
  let holdTimer: NodeJS.Timeout | null = null;

  const flushHold = (): void => { if (hold) { pt.write(hold); hold = ''; } holdTimer = null; };
  stdin.on('data', (chunk: string | Buffer) => {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    const { text, hold: h, replies } = splitCpr(hold + (typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    hold = h;
    for (const r of replies) onCpr(r);
    if (text) pt.write(text);
    if (hold) { holdTimer = setTimeout(flushHold, holdMs); holdTimer.unref(); }
  });
  stdin.on('end', () => { flushHold(); pt.end(); });

  const tty = pt as unknown as NodeJS.ReadStream;
  Object.defineProperty(tty, 'isTTY', { get: () => true });
  tty.setRawMode = (mode: boolean) => { stdin.setRawMode(mode); return tty; };
  tty.ref = () => { stdin.ref(); return tty; };
  tty.unref = () => { stdin.unref(); return tty; };
  return tty;
}
