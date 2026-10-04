// Trims Ink's row rewrites down to the cells that actually changed.
//
// Ink diffs the screen by ROW: when any cell of a row changes it rewrites the
// row from column 0, edge to edge. With two panes side by side that means the
// sidebar scrolling one line repaints the conversation's half of every
// shifted row — the left-pane flicker. Ink cannot do better (its diff is over
// line strings; per-cell diffing was rejected upstream as too complex), but
// this filter sits between Ink and the terminal, remembers the bytes last
// written to each row, and when a rewrite arrives whose left part is
// byte-identical to what the row already holds, it skips that part: cursor
// straight to the first changed column, replay the zero-width style codes the
// skipped part carried (the tail's colours depend on them), write the tail.
//
// Safety first: only writes the parser fully understands are trimmed. Ink
// emits a small closed set of control sequences (log-update.js and
// cursor-helpers.js); anything else passes through verbatim and forgets what
// was known about the screen, so the worst case is Ink's own behaviour,
// never a corrupted frame. Style state is tracked, and a row is only trimmed
// when the terminal's style state entering it was the default both times —
// a byte-identical prefix under a different inherited style would render
// differently — a byte-identical prefix under a different inherited style
// would render differently.
import stringWidth from 'string-width';

const MIN_SAVED_COLS = 8; // fewer saved cells than this is not worth the moves

const CSI = /^\x1b\[([0-9;?]*)([A-Za-z])/;
const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Coarse SGR state: enough to know "is everything back to the default". */
class SgrState {
  private fg: string | null = null;
  private bg: string | null = null;
  private attrs = new Set<number>();
  get clean(): boolean { return !this.fg && !this.bg && this.attrs.size === 0; }
  reset(): void { this.fg = null; this.bg = null; this.attrs.clear(); }
  apply(params: string): void {
    const codes = params === '' ? [0] : params.split(';').map((text) => (text === '' ? 0 : Number(text)));
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) this.reset();
      else if (code === 38 || code === 48) {
        // Extended colour: consumes 5;n or 2;r;g;b.
        const take = codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
        const val = codes.slice(i, i + 1 + take).join(';');
        if (code === 38) this.fg = val; else this.bg = val;
        i += take;
      } else if (code === 39) this.fg = null;
      else if (code === 49) this.bg = null;
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) this.fg = String(code);
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) this.bg = String(code);
      else if (code >= 1 && code <= 9) this.attrs.add(code);
      else if (code === 22) { this.attrs.delete(1); this.attrs.delete(2); }
      else if (code >= 23 && code <= 29) this.attrs.delete(code - 20);
      // Anything else is ignored: unknown codes do not make the state clean.
      else this.attrs.add(code);
    }
  }
}

interface RowMemory { raw: string; cleanEntry: boolean }

export interface Trim {
  /** Transform one chunk on its way to the terminal. */
  write(chunk: string): string;
  /** Forget everything (the screen was cleared or resized under us). */
  reset(): void;
}

export function createTrim(): Trim {
  // Ink positions the cursor RELATIVELY, always (cursor up, next line,
  // column; never an absolute address) — so rows here are relative to an
  // arbitrary anchor, not terminal rows. That is enough: the shadow only has
  // to agree with itself about which row a rewrite lands on, and relative
  // moves preserve that even across the terminal scrolling under the first
  // frame. `row = null` means the thread was lost (an escape the parser does
  // not model): everything passes through untouched from then on.
  let row: number | null = 0;
  let col: number | null = 0;
  const shadow = new Map<number, RowMemory>();
  const sgr = new SgrState();

  const invalidate = (): void => { row = null; col = null; shadow.clear(); };
  // A resize clamps the cursor and reflows the screen: what the rows held is
  // gone, but relative tracking stays consistent for everything after.
  const forget = (): void => { shadow.clear(); sgr.reset(); };

  /** Split a run (text + zero-width SGR codes) into units, walking to the
   *  largest safe boundary at or before byte offset `limit`. Returns the
   *  boundary byte offset, the visible width up to it, and the SGR codes in
   *  the skipped part, or null when the walk meets bytes it cannot place. */
  const boundary = (run: string, limit: number): { bytes: number; width: number; codes: string[] } | null => {
    let bytes = 0, width = 0;
    const codes: string[] = [];
    let i = 0;
    while (i < run.length) {
      let unitLen: number, unitWidth: number, unitSgr: string | null = null;
      if (run[i] === '\x1b') {
        const match = CSI.exec(run.slice(i));
        if (!match || match[2] !== 'm') return null;
        unitLen = match[0].length; unitWidth = 0; unitSgr = match[0];
      } else {
        let end = run.indexOf('\x1b', i);
        if (end === -1) end = run.length;
        // One grapheme at a time: a boundary must never split a glyph.
        const first = seg.segment(run.slice(i, end))[Symbol.iterator]().next().value as { segment: string };
        unitLen = first.segment.length;
        unitWidth = stringWidth(first.segment);
      }
      if (bytes + unitLen > limit) break;
      bytes += unitLen; width += unitWidth;
      if (unitSgr) codes.push(unitSgr);
      i = bytes;
    }
    return { bytes, width, codes };
  };

  /** A run written from column 0 of a known row: trim it against what the row
   *  already holds, and remember it. Returns what to send. */
  const flushRow = (run: string): string => {
    const rowIndex = row as number;
    const old = shadow.get(rowIndex);
    const cleanEntry = sgr.clean;
    // Advance the style state and the cursor through the run either way.
    for (const match of run.matchAll(/\x1b\[([0-9;]*)m/g)) sgr.apply(match[1]);
    shadow.set(rowIndex, { raw: run, cleanEntry });
    col = null; // end column is knowable but nothing downstream needs it
    if (!old || !old.cleanEntry || !cleanEntry) return run;
    let shared = 0;
    const max = Math.min(old.raw.length, run.length);
    while (shared < max && old.raw[shared] === run[shared]) shared++;
    const cut = boundary(run, shared);
    if (!cut || cut.width < MIN_SAVED_COLS) return run;
    return `\x1b[${cut.width + 1}G${cut.codes.join('')}${run.slice(cut.bytes)}`;
  };

  const write = (chunk: string): string => {
    const out: string[] = [];
    let run: string | null = null;   // pending row write (started at col 0)
    const endRun = (): void => {
      if (run === null) return;
      const text = run;
      run = null;
      // Style codes alone do not overwrite the row — only a run with visible
      // text is a row write the shadow may remember.
      const hasText = text.replace(/\x1b\[[0-9;]*m/g, '') !== '';
      if (row !== null && hasText) { out.push(flushRow(text)); return; }
      for (const match of text.matchAll(/\x1b\[([0-9;]*)m/g)) sgr.apply(match[1]);
      out.push(text);
    };
    let i = 0;
    while (i < chunk.length) {
      const char = chunk[i];
      if (char === '\x1b') {
        const match = CSI.exec(chunk.slice(i));
        if (!match) {
          // An escape Ink does not emit (OSC, charset, save/restore): give up
          // on this chunk — verbatim from here, and trust nothing after it.
          endRun(); invalidate();
          out.push(chunk.slice(i));
          return out.join('');
        }
        const [tok, params, final] = match;
        i += tok.length;
        if (final === 'm') {
          // Zero-width: part of the run if one is open — and a row's first
          // bytes are often its opening colour, so at column 0 a style code
          // STARTS the run. Elsewhere, track it and pass it.
          if (run !== null) { run += tok; continue; }
          if (col === 0 && row !== null) { run = tok; continue; }
          sgr.apply(params);
          out.push(tok);
          continue;
        }
        const endedRun = run !== null;
        endRun();
        out.push(tok);
        const count = params === '' ? 1 : Number(params.split(';')[0]) || 1;
        switch (final) {
          case 'A': if (row !== null) row -= count; break;
          case 'B': if (row !== null) row += count; break;
          case 'E': if (row !== null) row += count; col = 0; break;
          case 'G': col = (params === '' ? 1 : Number(params) || 1) - 1; break;
          case 'H': {
            const [toRow, toColumn] = params.split(';').map((text) => Number(text) || 1);
            row = (toRow || 1) - 1; col = (toColumn || 1) - 1;
            break;
          }
          case 'J': shadow.clear(); break;                        // 2J/3J: screen cleared
          case 'K':
            // The K that closes a row write belongs to the run just flushed —
            // the row's memory stays. A bare K erases (part of) the row.
            if (!endedRun && row !== null) shadow.delete(row);
            break;
          case 'h': case 'l': break;                              // modes: ?25, ?2026, ?1049 — no position
          default: invalidate(); break;                           // a move we do not model
        }
        continue;
      }
      if (char === '\n' || char === '\r') {
        i += 1;
        endRun();
        out.push(char);
        if (char === '\n' && row !== null) row += 1;
        col = 0;
        continue;
      }
      let end = chunk.indexOf('\x1b', i);
      const newlineAt = chunk.indexOf('\n', i), carriageReturnAt = chunk.indexOf('\r', i);
      for (const stop of [newlineAt, carriageReturnAt]) if (stop !== -1 && (end === -1 || stop < end)) end = stop;
      if (end === -1) end = chunk.length;
      const text = chunk.slice(i, end);
      i = end;
      if (run !== null) { run += text; continue; }
      if (col === 0 && row !== null) { run = text; continue; }
      // Text at an unknown or mid-row position: pass it, drop what we knew
      // about the row it lands on. (Escapes never reach here — text stops
      // at every \x1b — so no style tracking is needed on this path.)
      out.push(text);
      if (row !== null) shadow.delete(row);
      if (col !== null) col += stringWidth(text);
    }
    endRun();
    return out.join('');
  };

  return { write, reset: forget };
}
