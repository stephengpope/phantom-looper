// A pane: a clipped viewport over content that may be taller than it, anchored
// at the bottom like a chat. `offset` is how many rows up from the bottom the
// view sits (0 = following the tail). The pane measures itself and its content
// after each layout, so it knows whether the content fits (then it is top-
// aligned and cannot scroll) and how far up it can go.
//
// Two things here were found by experiment against Ink 7.1 and must stay:
//   - The content sits in ONE wrapper Box. Several <Text> rows directly under a
//     clipped, bottom-aligned Box lose a row (Ink drops the one straddling the
//     top edge); a single wrapper child clips correctly.
//   - Scrolling up is a NEGATIVE bottom margin on that wrapper, not a spacer: a
//     spacer pushes content up and shows blank rows, a negative margin lets the
//     content's tail run out under the bottom edge and shows the rows above.
//
// THE WINDOW. Only the items near the view are laid out — the ones above AND
// the ones below it are dropped, so the cost of a frame is the size of the
// screen, never the size of the conversation. That is the standard virtual
// list (react-window, virtuoso) and the reason is measured: laying out a whole
// transcript costs ~50ms at 40 messages, ~380ms at 2,000 and ~800ms at 5,000
// per scroll step, while a window holds ~50ms at any length.
//
// It needs to know how tall each item is, which only the terminal can say, so
// each drawn item reports its own height and the pane remembers it by key. An
// item never drawn yet is guessed at (the average of what has been measured);
// the guess is replaced by the truth the first time it is drawn, one screenful
// before it reaches the view. So the only thing a wrong guess can affect is how
// far `maxOffset` says you may still scroll into history you have never seen,
// and it self-corrects as you travel — the virtuoso bargain, and the only way
// to avoid it is to lay out everything, which is what costs 800ms.
//
// A previous version grew a tail-anchored window instead, and never dropped
// anything below the view. It could not grow at all: it widened only while the
// drawn rows were FEWER than the view plus the scroll, and the caller clamps
// the scroll to exactly the drawn rows — so at the top of the window the test
// read `contentRows < contentRows`, and history stopped dead 40 messages back.
import { Box, useBoxMetrics } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/** How much is drawn beyond the view, above and below, in screenfuls. One is
 *  enough that a scroll step always lands on measured, already-laid-out rows;
 *  more is more layout per frame for no gain. */
const OVERSCAN_PANES = 1;
/** The height of an item nothing has measured yet, before there is an average
 *  to go on: a plain message. Only ever a first guess. */
const GUESS_ROWS = 4;

export function Pane<T>({ items, render, offset, width, onMeasure, fill, topGap = false, keyFor }: {
  items: readonly T[];
  render: (item: T, index: number) => ReactNode;
  /** One blank row above the content, so the first thing in the pane never
   *  touches the top edge — whatever it is: a session header, a boot failure,
   *  a refresh note. Layout rather than a blank item in the list, so no path
   *  that fills the pane can forget it. It belongs to the content, so it
   *  scrolls away with the content once the conversation outgrows the view. */
  topGap?: boolean;
  /** Rows up from the bottom. Clamped to what the content allows. */
  offset: number;
  width: number;
  /** Reports how far up the view can go, so the caller can clamp its offset. */
  onMeasure?: (maxOffset: number) => void;
  /** What identifies an item across renders, for the height it was measured
   *  at. Defaults to its position, which is right for a list that only ever
   *  grows at the end; a caller whose list can be rebuilt (the conversation is,
   *  on a refresh) passes the item's own id so the measurements survive it. */
  keyFor?: (item: T, index: number) => string;
  /** Drawn in the empty space below short content (the launch banner), so
   *  the content itself — the session header — stays visible and pinned at
   *  the top. The caller unmounts it in one frame; while mounted it must
   *  not move, so it is centered in this box, not stacked against content. */
  fill?: ReactNode;
}) {
  const frame = useRef(null);
  const { height: paneRows, hasMeasured: measured } = useBoxMetrics(frame);

  // What each item measured, by key. A ref, not state: a height that has not
  // changed must not cost a render, and the ones that do change are collected
  // into ONE bump (`version`) by React's batching.
  const heights = useRef(new Map<string, number>());
  const [version, setVersion] = useState(0);
  const report = useCallback((key: string, rows: number) => {
    if (heights.current.get(key) === rows) return;
    heights.current.set(key, rows);
    setVersion((v) => v + 1);
  }, []);

  const total = items.length;
  const key = useCallback((i: number) => (keyFor ? keyFor(items[i], i) : String(i)), [items, keyFor]);

  // The window, and the geometry that follows from it. Recomputed only when
  // something it depends on moves — a measurement, the scroll, a new item.
  const w = useMemo(() => {
    const map = heights.current;
    // The guess for an item never drawn: what the drawn ones average. Ignore
    // keys left behind by other lists this pane has shown (it is reused across
    // sessions) by averaging only over items that are in the list now.
    let sum = 0, seen = 0;
    for (let i = 0; i < total; i++) {
      const h = map.get(key(i));
      if (h !== undefined) { sum += h; seen++; }
    }
    const guess = seen ? Math.max(1, Math.round(sum / seen)) : GUESS_ROWS;
    const rowsAt = (i: number) => map.get(key(i)) ?? guess;

    const gap = topGap ? 1 : 0;
    const contentRows = sum + (total - seen) * guess + gap;
    const view = Math.max(1, paneRows);
    const maxOffset = Math.max(0, contentRows - view);
    const at = Math.min(Math.max(0, offset), maxOffset);
    const overscan = view * OVERSCAN_PANES;

    // Walk up from the last item: skip what sits entirely below the view (plus
    // the overscan), then take items until the view is covered above it.
    let end = total - 1, below = 0;
    const skip = Math.max(0, at - overscan);
    while (end > 0) {
      const h = rowsAt(end);
      if (below + h > skip) break;
      below += h; end--;
    }
    let start = end, taken = 0;
    const need = (at - below) + view + overscan;
    while (start > 0 && taken < need) { taken += rowsAt(start); start--; }
    if (start < 0) start = 0;
    // The gap belongs to the top of the LIST, so it is only drawn when the top
    // of the list is in the window.
    return { start, end, below, contentRows, maxOffset, at, fits: contentRows <= view,
      gap: start === 0 ? gap : 0 };
    // `version` is the dependency that says a measurement moved.
  }, [items, key, offset, paneRows, topGap, total, version]);

  useEffect(() => { onMeasure?.(measured ? w.maxOffset : 0); }, [measured, w.maxOffset, onMeasure]);

  // A pane with no height draws nothing (react-virtualized's AutoSizer rule).
  // Yoga gives the children of a zero-height box no layout, so every item
  // would measure 0 rows, and a 0-row item reads as "scrolled out below the
  // view" — the window then walks up the whole conversation one commit at a
  // time until React's nested-update limit kills the app. The App's
  // repaint-on-resize collapses the screen to 0×0 for one frame, so this is
  // every terminal resize on a long session (2026-09-03). Holding the last
  // measurements and drawing nothing keeps them intact for the next frame.
  const blind = !measured || paneRows === 0;
  const drawn: ReactNode[] = [];
  for (let i = w.start; i <= w.end && i < total && !blind; i++) {
    const k = key(i);
    drawn.push(<Measured key={k} id={k} report={report}>{render(items[i], i)}</Measured>);
  }
  return (
    <Box ref={frame} flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}
      width={width} overflow="hidden" justifyContent={w.fits ? 'flex-start' : 'flex-end'}>
      <Box flexDirection="column" flexShrink={0} paddingTop={w.gap}
        marginBottom={w.fits ? 0 : -Math.max(0, w.at - w.below)}>
        {drawn}
      </Box>
      {w.fits && fill && !blind ? <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">{fill}</Box> : null}
    </Box>
  );
}

/** One item, reporting the rows it actually took. The wrapper is a plain
 *  column box that shrinks for nothing, so what it measures is exactly what
 *  the item draws — margins included. */
function Measured({ id, report, children }: {
  id: string; report: (key: string, rows: number) => void; children: ReactNode;
}) {
  const ref = useRef(null);
  const { height, hasMeasured } = useBoxMetrics(ref);
  useEffect(() => { if (hasMeasured) report(id, height); }, [hasMeasured, height, id, report]);
  return <Box ref={ref} flexDirection="column" flexShrink={0}>{children}</Box>;
}
