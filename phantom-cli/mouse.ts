// The mouse, the way fullscreen terminal apps do it (vim, tmux, Claude Code's
// fullscreen mode, Gemini CLI): ask the terminal to report mouse events, read
// them off stdin, and own scrolling and text selection ourselves — because in
// the alternate screen the terminal no longer scrolls or selects for us.
//
// Protocol (xterm): `\e[?1002h` reports presses, releases and drags (not bare
// motion — mode 1003 floods stdin), `\e[?1006h` picks the SGR encoding, which
// is unambiguous and has no 223-column limit:  `\e[<BTN;COL;ROWM` on press /
// wheel, `…m` on release; wheel up is 64, down 65; bit 32 marks a drag;
// bits 4/8/16 are shift/meta/ctrl; COL/ROW are 1-based.
//
// Ink has no mouse support. Its input parser reassembles the sequence and
// `useInput` hands it to EVERY handler as `input = "[<64;10;5M"` with the ESC
// stripped and no key flags set — so every handler that inserts text has to
// ask `isMouseInput()` first, or the wheel types into the prompt (a real
// Claude Code bug in tmux). App parses it once and routes it.
import { spawn } from 'node:child_process';

export const MOUSE_ON = '\x1b[?1002h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l';

const SGR = /^\x1b?\[<(\d+);(\d+);(\d+)([mM])$/;

export interface MouseEvent {
  kind: 'wheel' | 'press' | 'drag' | 'release';
  /** 0 left, 1 middle, 2 right; for wheel: -1 up, +1 down. */
  button: number;
  /** 0-based terminal column/row. */
  x: number; y: number;
  shift: boolean; meta: boolean; ctrl: boolean;
}

/** Is this `useInput` string (or raw stdin chunk) a mouse report? */
export function isMouseInput(input: string): boolean {
  return SGR.test(input);
}

export function parseMouse(input: string): MouseEvent | null {
  const m = SGR.exec(input);
  if (!m) return null;
  const code = Number(m[1]);
  const x = Number(m[2]) - 1;
  const y = Number(m[3]) - 1;
  const release = m[4] === 'm';
  const shift = (code & 4) !== 0, meta = (code & 8) !== 0, ctrl = (code & 16) !== 0;
  const low = code & 3;
  if (code >= 64 && code < 96) {
    // 64 up, 65 down (66/67 are horizontal — reported as a wheel with dir 0, ignored by callers)
    const dir = low === 0 ? -1 : low === 1 ? 1 : 0;
    return { kind: 'wheel', button: dir, x, y, shift, meta, ctrl };
  }
  if (code & 32) return { kind: 'drag', button: low, x, y, shift, meta, ctrl };
  return { kind: release ? 'release' : 'press', button: low, x, y, shift, meta, ctrl };
}

// --- selection ------------------------------------------------------------------

export interface Point { x: number; y: number }
/** A region the selection may not leave — the pane it started in. */
export interface Region { left: number; right: number }
export interface Selection { anchor: Point; head: Point; region: Region }
/** One highlighted row: columns x0..x1 inclusive. */
export interface Range { y: number; x0: number; x1: number }

/** The rows and columns a selection covers, reading order, clamped to its
 *  region: the first row from the start column to the region's right edge,
 *  whole rows between, the last row from the region's left edge to the end.
 *  Like a terminal's selection, but it cannot bleed into the other pane. */
export function selectionRanges(sel: Selection): Range[] {
  const { region } = sel;
  let a = sel.anchor, b = sel.head;
  if (b.y < a.y || (b.y === a.y && b.x < a.x)) [a, b] = [b, a];
  const clamp = (x: number) => Math.min(region.right, Math.max(region.left, x));
  const out: Range[] = [];
  for (let y = a.y; y <= b.y; y++) {
    const x0 = y === a.y ? clamp(a.x) : region.left;
    const x1 = y === b.y ? clamp(b.x) : region.right;
    if (x1 >= x0) out.push({ y, x0, x1 });
  }
  return out;
}

// --- clipboard ------------------------------------------------------------------

/** Put text on the system clipboard. The platform's own tool first (pbcopy on
 *  macOS; wl-copy / xclip / xsel on Linux); failing all of those, OSC 52 to
 *  the terminal, which iTerm2, kitty, WezTerm, Windows Terminal and tmux
 *  (with `set -g set-clipboard on`) honour. Resolves with what was used. */
export function copyToClipboard(text: string, stdout: { write(s: string): unknown } = process.stdout): Promise<string> {
  const tools: Array<[string, string[]]> = process.platform === 'darwin'
    ? [['pbcopy', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  return new Promise((resolve) => {
    const tryNext = (i: number) => {
      if (i >= tools.length) {
        stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
        resolve('osc52');
        return;
      }
      const [cmd, args] = tools[i];
      let child;
      try { child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] }); }
      catch { tryNext(i + 1); return; }
      child.on('error', () => tryNext(i + 1));
      child.on('exit', (code) => { if (code === 0) resolve(cmd); else tryNext(i + 1); });
      child.stdin.on('error', () => { /* exit handler decides */ });
      child.stdin.end(text);
    };
    tryNext(0);
  });
}
