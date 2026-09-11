// Paste chips — a big paste never lands in the prompt as text.
//
// The prompt holds only a chip, `[Pasted #1 ~12 lines]`; the pasted text
// lives here, keyed by the chip's number. At submit the chips are swapped
// back for their text (window.ts submit), so the session and transcript
// only ever see full text — nothing downstream knows a paste happened.
// The store is in-memory for the app's run: a recalled line's chips still
// resolve, and deleting a chip from the box drops its text (the swap finds
// no chip, the text is never sent). The one case it cannot cover is a chip
// recalled into a LATER run — that chip has no entry, and expand() strips
// it rather than letting the literal chip reach the model (the bug both
// Claude Code and opencode shipped).
//
// The chip carries its own id (#1) rather than linking by cursor position
// (opencode's tracked ranges): our prompt is a plain string, so an id in
// the text is the link that survives every edit around it for free.
//
// File chips — a drag-and-drop file gets a `[📎 file.txt]` chip at the
// cursor. The store maps the chip's name to the scratch pad path the
// backend returned. On submit, each file chip expands to its path — the
// agent sees the path inline in the user's message, alongside the backdoor
// message that describes the file.

/** One whole paste chip, e.g. `[Pasted #2 ~12 lines]`. */
const PASTE_CHIP = /\[Pasted #(\d+) ~(\d+) lines\]/g;

/** One whole file chip, e.g. `[📎 readme.md]`. */
const FILE_CHIP = /\[📎 ([^\]]+)\]/g;

/** Any chip at the very end of a string — what a backspace should remove whole. */
const CHIP_AT_END = /(?:\[Pasted #\d+ ~\d+ lines\]|\[📎 [^\]]+\])$/;

/** Over this, a paste becomes a chip. Under it, text lands as typed. */
const MIN_LINES = 3;
const MIN_CHARS = 150;

export class PasteStore {
  private texts = new Map<number, string>();
  private nextId = 1;

  /** file chip name → scratch pad path */
  private files = new Map<string, string>();

  /** Collapse a big paste into its chip; a small paste returns null and the
   *  caller inserts the text as-is. */
  collapse(text: string): string | null {
    const trimmed = text.trim();
    const lines = trimmed === '' ? 0 : trimmed.split('\n').length;
    if (lines < MIN_LINES && trimmed.length < MIN_CHARS) return null;
    const id = this.nextId++;
    this.texts.set(id, trimmed);
    return `[Pasted #${id} ~${lines} lines]`;
  }

  /** Store a dropped file's path and return the chip to insert at the cursor.
   *  The same filename dropped twice overwrites the path — the latest drop
   *  wins, which is what the user expects. */
  collapseFile(name: string, scratchPath: string): string {
    this.files.set(name, scratchPath);
    return `[📎 ${name}]`;
  }

  /** Swap each chip in a submitted line for its stored text / path. A chip
   *  with no entry (recalled from an earlier run, or never ours) is stripped
   *  and reported in `missing` — the literal chip is never sent. */
  expand(line: string): { text: string; missing: number[] } {
    const missing: number[] = [];
    let text = line.replace(PASTE_CHIP, (_chip, id) => {
      const stored = this.texts.get(Number(id));
      if (stored === undefined) { missing.push(Number(id)); return ''; }
      return stored;
    });
    text = text.replace(FILE_CHIP, (_chip, name) => {
      const stored = this.files.get(name);
      if (stored === undefined) return ''; // stale chip — strip it
      return stored;
    });
    return { text, missing };
  }
}

/** The length of the chip `text` ends with, or 0 — TextInput's backspace
 *  removes a chip whole rather than eating into it a character at a time. */
export function chipAtEnd(text: string): number {
  const m = text.match(CHIP_AT_END);
  return m ? m[0].length : 0;
}
