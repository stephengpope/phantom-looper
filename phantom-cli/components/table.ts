// /resume's column system, made reusable — ONE place owns the geometry a
// column-aligned SelectList page needs, so no screen hand-pads a header
// against magic widths again (the Launcher and /tasks both drifted a copy).
//
// What SelectList renders per row: a 2-cell cursor gutter, a 2-cell marker
// slot once ANY row is marked, the label in a content-sized column, then
// each column as a fixed-width box with a two-cell gutter INSIDE the width.
// The header goes through that SAME layout: a heading Choice WITH columns is
// a table header — label = the label column's title, columns = the titles at
// the rows' widths. It used to be a padEnd'd string mirroring the boxes;
// mirrors drift (clipped at a pane edge, string and boxes truncated
// differently), one path cannot.
//
// Column sizing has two modes on purpose:
// - `width` FIXES a column. A status list that refreshes in place (/resume,
//   /tasks) must not jitter as values change under it — that is why /resume
//   pins name/message/who instead of sizing to content.
// - no width: sized to the widest cell (capped), for content that is stable
//   for the life of the screen. The LAST column always runs free.
//
// A cell is a string, or `{ text, mark }` when it carries a severity mark —
// the colored • SelectList draws ahead of the text. The mark costs two cells,
// counted here so a content-sized column still fits.
import { type Choice, type Column } from './SelectList.js';

/** One column after the label. `title` heads it; `width` fixes it (gutter
 *  included, SelectList's convention); `cap` bounds content-sizing. */
export interface ColSpec { title: string; width?: number; cap?: number }

/** A cell's content: the text, or the text with a mark (an Ink color name)
 *  drawn as a colored • ahead of it. */
export type Cell = string | { text: string; mark?: string };

/** One row: `cells[0]` is the label (its mark, if any, is ignored — the
 *  label column has no mark slot), the rest sit under `cols` in order.
 *  Marker/hint fields pass straight through to the Choice. */
export interface TableRow<T> {
  value: T;
  cells: Cell[];
  busy?: boolean; dot?: boolean; lock?: boolean; hint?: string;
}

const GUTTER = 2;
/** The mark and the space after it. */
const MARK = 2;

const cellOf = (c: Cell | undefined): { text: string; mark?: string } =>
  typeof c === 'string' ? { text: c } : c ?? { text: '' };
/** Cells the content takes on screen — the mark included. */
const cellWidth = (c: Cell | undefined): number => {
  const { text, mark } = cellOf(c);
  return text.length + (mark ? MARK : 0);
};
/** The Column for a cell: `mark` only when set, so an unmarked cell keeps the
 *  exact `{ text, width? }` shape. */
const column = (c: Cell | undefined, width: number | undefined): Column => {
  const { text, mark } = cellOf(c);
  return { text, ...(width ? { width } : {}), ...(mark ? { mark } : {}) };
};

/** The aligned table: a dim header Choice over the rows, geometry computed
 *  once from the same data SelectList will render. */
export function tableChoices<T>(
  labelTitle: string, cols: ColSpec[], rows: TableRow<T>[],
): Choice<T | null>[] {
  const widths = cols.map((c, i) => {
    if (c.width) return c.width;
    if (i === cols.length - 1) return undefined;
    const widest = rows.reduce((w, r) => Math.max(w, cellWidth(r.cells[i + 1])), c.title.length);
    return Math.min(c.cap ?? 32, widest) + GUTTER;
  });
  // The header IS a row: same label box, same column boxes, rendered dim by
  // SelectList's structured-heading path. It used to be a hand-padEnd'd
  // string — a SECOND copy of the geometry, which disagreed with the rows
  // the moment the table outgrew its pane (boxes clip at the pane edge, a
  // padded string truncates its own way). One layout path cannot disagree
  // with itself.
  const header: Choice<T | null> = {
    value: null as T | null, heading: true, label: labelTitle,
    columns: cols.map((c, i): Column =>
      widths[i] ? { text: c.title, width: widths[i] } : { text: c.title }),
  };
  return [header, ...rows.map((r): Choice<T | null> => ({
    value: r.value,
    label: cellOf(r.cells[0]).text,
    columns: r.cells.slice(1).map((cell, i): Column => column(cell, widths[i])),
    busy: r.busy, dot: r.dot, lock: r.lock, hint: r.hint,
  }))];
}
