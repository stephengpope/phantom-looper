// A scroll-capped selection list. Ink has no built-in; @inkjs/ui has one but
// has not shipped since May 2024, and the whole need is one useInput and a
// window slice — so we own it rather than depend on a dormant package.
//
// Layout law: every region this list renders holds ONE height while it is on
// screen. The row window is sized from the page budget, the more-line is
// always one row, and the hint block is exactly HINT_ROWS whether the hint is
// long, short or absent. Anything that grows and shrinks under a
// bottom-anchored pane rewrites every shifted row — the flicker the slash
// menu measured at 25 of 30 rows per keystroke.
import { Box, useInput } from 'ink';
import { Text } from './Text.js';
import Spinner from 'ink-spinner';
import { useContext, useRef, useState } from 'react';
import { BudgetContext, SizeContext } from './Screen.js';

/** Break a hint into lines of a readable measure, keeping the blank lines it
 *  already has. Capped at 76 even on a wide window: prose set to the full
 *  width is hard to read back to the start of the next line. */
export function wrapHint(hint: string, width = 76): string[] {
  const out: string[] = [];
  for (const para of hint.split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!line) line = word;
      else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out;
}

/** One cell of a row's right-hand side. `width` pads and truncates; the last
 *  column may omit it and run free. The column math that four screens each
 *  hand-rolled with padEnd lives here now. `mark` is an Ink color name: a
 *  colored • drawn ahead of the text (two cells, counted inside `width`) —
 *  severity at a glance where the words stay dim (/resume's work column). */
export interface Column { text: string; width?: number; mark?: string }

/** A column cell: the dim text, with its mark ahead of it when it has one.
 *  The mark is a SIBLING in a pinned two-cell box, never nested in the dim
 *  Text — Ink applies a parent Text's transform over its children's, so a
 *  nested mark would come out dim-red; and Text is flexShrink 1, so an
 *  unpinned sibling would be squeezed when the row overflows. Same shape as
 *  the marker slot. */
function Cell({ col }: { col: Column }) {
  const text = <Text dimColor wrap="truncate-end">{col.text}</Text>;
  if (!col.mark) return text;
  return (
    <>
      <Box width={2} flexShrink={0}><Text color={col.mark}>•</Text></Box>
      {text}
    </>
  );
}

/** The label column's width for the longest label in a list: content capped,
 *  THEN the two-cell gutter — a label at the cap truncates and still keeps
 *  its gap (gutter inside the cap left /tasks commands flush against the
 *  status column). ONE formula — a screen drawing a header over the list's
 *  columns (the /resume launcher) imports this rather than mirroring a
 *  number that can drift. */
export const labelWidthFor = (widest: number): number => Math.min(32, widest) + 2;

export interface Choice<T> {
  value: T;
  label: string;
  /** Right-hand column — a current value, or where it came from. */
  detail?: string;
  /** Aligned right-hand columns; wins over `detail` when present. On a
   *  `heading` row this makes it a TABLE HEADER: rendered through the same
   *  boxes as the data rows (dim, unselectable), so the header and the
   *  columns it names cannot disagree — clipped, truncated or not. */
  columns?: Column[];
  /** This row is doing something RIGHT NOW: an animated spinner (the status
   *  line's dots) draws ahead of the detail, so a working session cannot be
   *  mistaken for an idle one at a glance. */
  busy?: boolean;
  /** This row is live in this window but idle: a steady dot in the spinner's
   *  slot — same place, same color, just not moving. `busy` wins when both. */
  dot?: boolean;
  /** Held by ANOTHER window: the same steady dot, yellow — same shape because
   *  both mean "alive somewhere", a different color because it is not here. */
  lock?: boolean;
  /** Shown under the list when this row is highlighted. One short literal
   *  sentence; anything past HINT_ROWS wrapped lines is cut. */
  hint?: string;
  /** Dim, non-selectable group heading. */
  heading?: boolean;
}

export function SelectList<T>({ choices, onSelect, onCancel, onKey, onNearEnd, initial, reserve = 0, pad = false, total }: {
  choices: Choice<T>[];
  onSelect: (value: T) => void;
  /** The row the cursor starts on. A screen that swaps this list for an
   *  editor and back (every settings screen) passes the row it left from, so
   *  the cursor comes back to the setting you just changed rather than to the
   *  top. Unknown or a heading => the first pickable row, as with no value. */
  initial?: T;
  onCancel?: () => void;
  /** Plain-letter shortcuts (e.g. `d` to reset), given the highlighted value. */
  onKey?: (ch: string, value: T | undefined) => void;
  /** The cursor moved into the last NEAR_END rows — a lazily loaded list
   *  (/resume) fetches its next page here, early enough that rows usually
   *  arrive before the bottom is reached. Fires per step; the caller guards
   *  against firing while a fetch is already out or the list is complete. */
  onNearEnd?: () => void;
  /** Rows the page spends beside this list (an input line above it, a
   *  preamble) — subtracted from the window so the page still fits. */
  reserve?: number;
  /** How many pickable rows the WHOLE list has, when the caller knows and
   *  `choices` holds only the pages loaded so far (/resume): the "↓ N more"
   *  line then counts what is really below, not what happens to be loaded.
   *  Headings are not rows. Omitted = the loaded choices are the list. */
  total?: number;
  /** Render blank rows for unused window slots. For a list whose choices
   *  change while it is on screen (the combobox filtering as you type): the
   *  slots hold the height, so the rows above and below never move. */
  pad?: boolean;
}) {
  const pickable = choices.map((c, i) => (c.heading ? -1 : i)).filter((i) => i >= 0);
  const [cursorRaw, setCursor] = useState(() => {
    const at = initial === undefined ? -1 : choices.findIndex((c) => !c.heading && c.value === initial);
    return at >= 0 ? at : pickable[0] ?? 0;
  });

  // The window is sized from the page budget Screen provides — no per-screen
  // `visible={N}` constants to outgrow a small terminal. The list's own
  // fixed rows (more-line, hint gap, hint block) are counted here because
  // they are rendered here.
  const budget = useContext(BudgetContext);
  const { cols } = useContext(SizeContext);
  const visible = Math.max(3, budget - reserve - 2 - HINT_ROWS);

  // A stored index only means something for the list it was chosen in. React
  // reuses this component when a caller swaps its choices (same element type in
  // the same position), so the old index can land on a heading — which draws no
  // cursor and ignores enter, leaving the list looking dead. Normalise on read.
  const normalize = (i: number) =>
    (choices[i] && !choices[i].heading ? i : pickable[0] ?? 0);
  const cursor = normalize(cursorRaw);

  // The cursor is mirrored in a ref so a keypress can read where the highlight
  // is RIGHT NOW without a setState updater. Reading it from the render closure
  // loses the second of two keypresses batched into one React update (holding
  // an arrow key); reading it inside a setCursor updater works, but the updater
  // runs during render, so calling onSelect/onKey there sets state on the
  // parent mid-render — "Cannot update a component while rendering a different
  // component". The ref is the only place that is both fresh and outside render.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const step = (dir: 1 | -1) => {
    const from = normalize(cursorRef.current);
    const at = pickable.indexOf(from);
    const next = pickable[(at + dir + pickable.length) % pickable.length] ?? from;
    cursorRef.current = next;
    setCursor(next);
    if (onNearEnd && next >= choices.length - NEAR_END) onNearEnd();
  };

  /** The highlighted row, or undefined when it is a heading. */
  const current = () => {
    const c = choices[normalize(cursorRef.current)];
    return c && !c.heading ? c : undefined;
  };

  useInput((ch, key) => {
    if (key.downArrow) step(1);
    else if (key.upArrow) step(-1);
    else if (key.return) { const c = current(); if (c) onSelect(c.value); }
    else if (key.escape) onCancel?.();
    // Same ref read as enter: the shortcut must act on the row that is
    // highlighted right now, not the one a stale closure remembers.
    //
    // A chord is not a shortcut. Ink reports ctrl+c as the letter `c` with
    // key.ctrl set, so without this ctrl+c would fire the `c` shortcut on the
    // way past — and ctrl+e on the workspace list would open the editor.
    else if (onKey && ch && !key.ctrl && !key.meta) onKey(ch, current()?.value);
  });

  // The label column sizes itself to its longest label. A fixed width silently
  // wrapped any row that outgrew it — the label on one line, its value on the
  // next — which reads as a broken list rather than a long name. Capped so one
  // very long label cannot push every value off the right edge, and truncated
  // rather than wrapped so a row is always exactly one line.
  // Structured headings (table headers) count too: the label column must at
  // least fit its own title, or an empty table truncates its header away.
  const widest = choices.reduce((w, c) =>
    c.heading && !c.columns ? w : Math.max(w, c.label.length), 0);
  const labelWidth = labelWidthFor(widest);

  // Keep the cursor inside the window without ever showing more than `visible`.
  const start = Math.max(0, Math.min(cursor - Math.floor(visible / 2), choices.length - visible));
  const window = choices.slice(Math.max(0, start), Math.max(0, start) + visible);
  const above = Math.max(0, start);
  const rowsIn = (cs: Choice<T>[]) => cs.filter((c) => !c.heading).length;
  const below = total === undefined
    ? choices.length - window.length - above
    : Math.max(0, total - rowsIn(choices.slice(0, above)) - rowsIn(window));
  const hint = choices[cursor]?.hint;

  // Any marker in the list means EVERY row carries the two-cell marker slot
  // (blank when unmarked), so details line up in one column. A list that
  // never marks (settings, workspaces) keeps its flush layout.
  const hasMarkers = choices.some((c) => c.busy || c.dot || c.lock);

  // The hint, wrapped HERE to a fixed measure rather than left to Ink — Ink
  // wraps at the terminal's full width, which reads as a broken line rather
  // than a paragraph. Then CUT to HINT_ROWS: the block is exactly that tall
  // whatever is highlighted, because a hint that changes height as you arrow
  // through the list moves the footer and the prompt under it up and down.
  const hintLines = (hint ? wrapHint(hint, Math.min(76, cols - 6)) : []).slice(0, HINT_ROWS);
  const slots = pad ? visible : window.length;
  return (
    <Box flexDirection="column">
      {Array.from({ length: slots }, (_, i) => {
        const c = window[i];
        if (!c) return <Text key={`pad${i}`}> </Text>;
        const idx = above + i;
        const on = idx === cursor;
        if (c.heading && !c.columns) return <Text key={idx} dimColor wrap="truncate-end">{` ${c.label}`}</Text>;
        if (c.heading && c.columns) {
          // The table header, through the SAME boxes as the rows below it —
          // never a hand-padded string that can drift from them.
          return (
            <Box key={idx}>
              <Box width={2} flexShrink={0} />
              {hasMarkers ? <Box width={2} flexShrink={0} /> : null}
              <Box width={labelWidth} flexShrink={0} paddingRight={2}>
                <Text dimColor wrap="truncate-end">{c.label}</Text>
              </Box>
              {c.columns.map((col, j) => col.width
                ? <Box key={j} width={col.width} flexShrink={0} paddingRight={2}><Text dimColor wrap="truncate-end">{col.text}</Text></Box>
                : <Text key={j} dimColor wrap="truncate-end">{col.text}</Text>)}
            </Box>
          );
        }
        const cols_ = c.columns ?? (c.detail !== undefined ? [{ text: c.detail }] : []);
        return (
          <Box key={idx}>
            {/* THE COLUMN LAW: a gutter is paddingRight INSIDE a fixed,
                flexShrink=0 box — never leftover space. When a row overflows
                the terminal, yoga reclaims spare space and squeezes
                shrinkable boxes FIRST, which is exactly the recurring
                columns-flush-together bug (each row shrank by its own
                content, so gaps vanished and columns jittered row to row).
                With every column pinned, overflow can only truncate the
                row's TAIL — the free last column — never a gap. */}
            <Box width={2} flexShrink={0}>
              <Text color={on ? 'cyan' : undefined}>{on ? '❯ ' : '  '}</Text>
            </Box>
            {/* A HARD two-cell marker box, FIRST — activity reads down the
                left edge, and the glyph's own measured width can never shift
                the columns behind it. */}
            {hasMarkers ? (
              <Box width={2} flexShrink={0}>
                {/* U+2022 BULLET: unambiguous single-cell width — U+25CF ●
                    measures wide in Ink but renders narrow in Terminal.app,
                    which skewed every marked row by one cell. */}
                {c.busy ? <Text color="magenta"><Spinner type="dots" /></Text>
                  : c.dot ? <Text color="magenta">•</Text>
                    : c.lock ? <Text color="yellow">•</Text> : null}
              </Box>
            ) : null}
            {/* paddingRight makes the label's gutter REAL: a label at (or
                past) the cap truncates into its content area and the two-cell
                gap still renders — spare space would be the first thing an
                overflowing row loses. */}
            <Box width={labelWidth} flexShrink={0} paddingRight={2}>
              <Text color={on ? 'cyan' : undefined} bold={on} wrap="truncate-end">{c.label}</Text>
            </Box>
            {/* One row is ONE line: a long column truncates, never wraps.
                paddingRight keeps a two-cell gutter INSIDE the width — a full
                column truncates into its gutter, never flush into the next. */}
            {cols_.map((col, j) => col.width
              ? <Box key={j} width={col.width} flexShrink={0} paddingRight={2}><Cell col={col} /></Box>
              : <Cell key={j} col={col} />)}
          </Box>
        );
      })}
      {/* Always one line, blank when nothing is hidden — so the rows below do
          not hop when the window scrolls onto or off an end of the list. */}
      {choices.length > 0 || pad ? (
        <Text dimColor>{above > 0 || below > 0
          ? `  ${[above > 0 ? `↑ ${above}` : '', below > 0 ? `↓ ${below}` : ''].filter(Boolean).join(' · ')} more`
          : ' '}</Text>
      ) : null}
      {/* Exactly HINT_ROWS tall, hint or no hint. The inner flexShrink=0
          wrapper is load-bearing: bare Text rows under a height-capped Box get
          SHRUNK by yoga (six rows render as "b d f"), not clipped — the same
          Ink behaviour Pane.tsx documents. Verified against Ink 7.1.1. */}
      {choices.length > 0 || pad ? (
        <Box marginTop={1} paddingLeft={2} height={HINT_ROWS} overflow="hidden" flexDirection="column">
          <Box flexDirection="column" flexShrink={0}>
            {Array.from({ length: HINT_ROWS }, (_, i) =>
              <Text key={i} dimColor wrap="truncate-end">{hintLines[i] || ' '}</Text>)}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

/** Rows the hint block always occupies — a hint is at most three lines and a
 *  longer one is cut, never allowed to grow the block. */
export const HINT_ROWS = 3;

/** How close to the bottom the cursor gets before onNearEnd fires. Bigger
 *  than a fetch is slow: ten rows of arrow-holding is plenty of time for the
 *  next page to land, so the bottom rarely arrives before its rows do. */
export const NEAR_END = 10;
