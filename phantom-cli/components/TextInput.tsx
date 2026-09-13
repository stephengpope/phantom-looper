// The single-line editor, ours.
//
// It replaces `ink-text-input`, which filters exactly four keys — up, down,
// ctrl+c and tab — and inserts EVERYTHING else as literal text. That is not a
// style preference: it means ctrl+o typed an `o` into the prompt every time it
// toggled thinking, and it put the whole ctrl range out of reach for any
// shortcut. Same reason `SelectList` is ours (see CLAUDE.md): the Ink
// satellites were last published in May 2024.
//
// The rule here is the inverse of that package's: a key is text only if it
// LOOKS like text. Anything with ctrl or meta on it, and every named key this
// editor does not act on, is left for the handlers above to claim.
//
// Cursor state is ours too, so a value changed from outside — tab completion,
// ↑ through what you said before — puts the cursor at the end without the
// caller having to remount the component to move it.
//
// Up/down: the text wraps visually at `columns` display-width positions (Ink's
// wrap-ansi hard wrap). The cursor navigates between visual rows using
// string-width to compute the correct character offset — the same display-width
// measure Ink uses to decide where lines break. The approach follows
// react-ink-textarea's computeVisualUpCursor / computeVisualDownCursor.
import { usePaste } from 'ink';
import { useInput } from './useInput.js';
import { Text } from './Text.js';
import { isMouseInput } from '../mouse.js';
import { PasteStore, chipAtEnd } from '../paste.js';
import { parseDrop } from '../drop.js';
import { useEffect, useRef, useState } from 'react';
import stringWidth from 'string-width';

/** Reverse video for one character. Written out rather than pulled from chalk,
 *  which is only in the tree as one of Ink's own dependencies. */
const invert = (s: string) => `\x1b[7m${s}\x1b[27m`;

// ── visual row mapping ────────────────────────────────────────────────────
// Ink wraps text using wrap-ansi with display-width (string-width) columns.
// To navigate up/down we need to know which visual row a character offset
// sits on and where the same visual column lands on the adjacent row.
// Each row is { start, end } in CHARACTER offsets (not display columns).

interface VRow { start: number; end: number }

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Split `text` into visual rows of at most `width` display columns each.
 *  Matches Ink's hard-wrap behaviour: break at the grapheme whose display
 *  width would exceed the column budget, never mid-grapheme. Iterates by
 *  grapheme cluster (Intl.Segmenter) so surrogate pairs and emoji sequences
 *  are never split — the same approach react-ink-textarea uses. */
function visualRows(text: string, width: number): VRow[] {
  if (width <= 0 || !text.length) return [{ start: 0, end: text.length }];
  const rows: VRow[] = [];
  let start = 0;
  let col = 0;
  for (const { segment, index } of segmenter.segment(text)) {
    const gw = stringWidth(segment);
    if (col + gw > width && index > start) {
      rows.push({ start, end: index });
      start = index;
      col = 0;
    }
    col += gw;
  }
  rows.push({ start, end: text.length });
  return rows;
}

/** The display-column offset of `cursor` within its visual row. */
function visualCol(text: string, rowStart: number, cursor: number): number {
  return stringWidth(text.slice(rowStart, cursor));
}

/** The character offset at (or nearest to) a target display column on a row. */
function charAtVisualCol(text: string, rowStart: number, rowEnd: number, targetCol: number): number {
  let col = 0;
  const slice = text.slice(rowStart, rowEnd);
  for (const { segment, index } of segmenter.segment(slice)) {
    const gw = stringWidth(segment);
    if (col + gw > targetCol) return rowStart + index;
    col += gw;
  }
  return rowEnd;
}

export function TextInput({ value, onChange, onSubmit, focus = true, placeholder = '', mask, pastes, onFileDrop, columns, onBoundary }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  focus?: boolean;
  placeholder?: string;
  /** Draw this character in place of each one typed — a key being entered. */
  mask?: string;
  /** Given, a big paste lands as a chip (`[Pasted #1 ~12 lines]`) and its
   *  text lives in the store until submit swaps it back (see paste.ts). */
  pastes?: PasteStore;
  /** Given, a paste that IS a dragged file's path (drop.ts) goes here.
   *  Returns chip text to insert at the cursor (e.g. `[📎 file.txt]`),
   *  or null when nothing should be inserted. */
  onFileDrop?: (paths: string[]) => Promise<string | null>;
  /** Display width in columns — enables up/down cursor navigation within
   *  wrapped text. Without it, up/down are left for the handlers above. */
  columns?: number;
  /** Called when up is pressed on the first visual line or down on the last.
   *  The parent uses it for history recall — TextInput cannot navigate
   *  further, so the keypress belongs to whatever is above. */
  onBoundary?: (dir: 'up' | 'down') => void;
}) {
  const [cursorState, setCursorState] = useState(value.length);
  // The cursor is mirrored in a ref and READ from the ref: two keypresses
  // batched into one React update (holding an arrow key, or a fast paste of
  // two arrows) would both read the same stale closure value otherwise —
  // the second ← would land where the first one started. Same rule, same fix,
  // as SelectList's cursor.
  const cursorRef = useRef(cursorState);
  const setCursor = (n: number) => { cursorRef.current = n; setCursorState(n); };
  const cursor = cursorRef.current;
  // The last value this component produced. Anything else arriving in `value`
  // came from the caller, and the cursor belongs at the end of it.
  const ours = useRef(value);
  useEffect(() => {
    if (value !== ours.current) { ours.current = value; setCursor(value.length); }
  }, [value]);

  // Same for the text: `value` in the closure is one keypress behind when two
  // arrive in one batch, so the handler edits what it last wrote.
  const valueRef = useRef(value);
  valueRef.current = value;

  useInput((input, key) => {
    // Not text: a chord, or a key some handler above this one owns. Returning
    // here is what makes ctrl+<letter> and the arrow keys usable at all.
    if (key.ctrl || key.meta) return;
    if (key.tab || key.escape || key.pageUp || key.pageDown) return;
    // Up/down: vertical cursor movement within wrapped text when we know the
    // display width. On the boundary (first line up, last line down) the
    // parent gets the event for history recall. Without `columns` the arrows
    // are left alone — the old behaviour, no regression.
    if (key.upArrow || key.downArrow) {
      if (!columns || columns <= 0) return;
      const value = valueRef.current;
      const cursor = cursorRef.current;
      const rows = visualRows(value, columns);
      const rowIdx = rows.findIndex((r) => cursor >= r.start && cursor <= r.end
        && (cursor < r.end || r === rows[rows.length - 1]));
      if (key.upArrow) {
        if (rowIdx <= 0) { onBoundary?.('up'); return; }
        const col = visualCol(value, rows[rowIdx]!.start, cursor);
        const prev = rows[rowIdx - 1]!;
        setCursor(charAtVisualCol(value, prev.start, prev.end, col));
      } else {
        if (rowIdx >= rows.length - 1) { onBoundary?.('down'); return; }
        const col = visualCol(value, rows[rowIdx]!.start, cursor);
        const next = rows[rowIdx + 1]!;
        setCursor(charAtVisualCol(value, next.start, next.end, col));
      }
      return;
    }
    // A mouse report ("[<64;10;5M", see mouse.ts) reaches every handler as
    // plain text; App routes it — it must never be typed into the box.
    if (isMouseInput(input)) return;

    const value = valueRef.current;
    const cursor = cursorRef.current;
    if (key.return) { onSubmit?.(value); return; }

    let next = value;
    let at = cursor;
    if (key.leftArrow) at = Math.max(0, cursor - 1);
    else if (key.rightArrow) at = Math.min(value.length, cursor + 1);
    else if (key.home) at = 0;
    else if (key.end) at = value.length;
    else if (key.backspace || key.delete) {
      // A chip deletes whole — eating into it a character at a time would
      // strand a half-chip whose text can never be swapped back in.
      const chip = chipAtEnd(value.slice(0, cursor));
      const remove = chip || (cursor > 0 ? 1 : 0);
      if (remove) { next = value.slice(0, cursor - remove) + value.slice(cursor); at = cursor - remove; }
    } else if (input) {
      // A paste arrives as one multi-character input; so does a single letter.
      // Control characters that reached here anyway are not text.
      // eslint-disable-next-line no-control-regex
      let text = input.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      if (!text) return;
      // A big paste becomes a chip; the text waits in the store for submit.
      if (pastes) text = pastes.collapse(text) ?? text;
      next = value.slice(0, cursor) + text + value.slice(cursor);
      at = cursor + text.length;
    }

    setCursor(at);
    if (next !== value) { ours.current = next; valueRef.current = next; onChange(next); }
  }, { isActive: focus });

  // A paste rides Ink's paste channel, not useInput: bracketed paste mode
  // (which the hook enables) makes the terminal wrap the paste in markers,
  // so the WHOLE paste arrives as one string no matter how many stdin
  // chunks it took. Collapsing per chunk — the useInput path — made one
  // paste over the threshold land as two chips.
  usePaste((pasted) => {
    // Pasted line breaks arrive as \r; the store counts lines by \n. The
    // control-character rule is the same one typed input follows above.
    let text = pasted.replace(/\r\n?/g, '\n');
    // eslint-disable-next-line no-control-regex
    text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    if (!text) return;
    // A dragged file is a paste of its path (drop.ts): the window uploads
    // it and returns a chip to insert at the cursor position.
    if (onFileDrop) {
      const dropped = parseDrop(text);
      if (dropped) {
        void onFileDrop(dropped).then((chip) => {
          if (!chip) return;
          const v = valueRef.current;
          const c = cursorRef.current;
          const next = v.slice(0, c) + chip + v.slice(c);
          setCursor(c + chip.length);
          ours.current = next; valueRef.current = next; onChange(next);
        });
        return;
      }
    }
    if (pastes) text = pastes.collapse(text) ?? text;
    const value = valueRef.current;
    const cursor = cursorRef.current;
    const next = value.slice(0, cursor) + text + value.slice(cursor);
    setCursor(cursor + text.length);
    if (next !== value) { ours.current = next; valueRef.current = next; onChange(next); }
  }, { isActive: focus });

  // Hard wrap: Ink breaks at exact display-width positions (no word wrap), so
  // visual line breaks match our string-width-based row computation above.
  const wrap = 'hard' as const;

  if (!value.length) {
    const shown = placeholder
      ? (focus ? invert(placeholder.slice(0, 1)) + placeholder.slice(1) : placeholder)
      : (focus ? invert(' ') : '');
    return <Text wrap={wrap} dimColor={!!placeholder}>{shown}</Text>;
  }
  const shown = mask ? mask.repeat(value.length) : value;
  if (!focus) return <Text wrap={wrap}>{shown}</Text>;
  // The cursor sits ON a character, or on a trailing space past the end.
  return (
    <Text wrap={wrap}>
      {shown.slice(0, cursor) + invert(shown[cursor] ?? ' ') + shown.slice(cursor + 1)}
    </Text>
  );
}
