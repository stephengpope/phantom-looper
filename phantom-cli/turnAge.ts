// How long a turn has been running, said in the colour of the spinner that is
// already on screen. One rule, one place: the board, the status line, the
// toolbar and the session list all age a turn the same way, so magenta means
// the same thing everywhere you see it.
//
// Colour rather than text because the places this shows are the tightest ones
// in the app — a card row's two-cell gutter, a toolbar that truncates — and a
// number would cost width on every row to say something that matters on one.
//
// This is a WARNING, not an error. A long turn is not wrong; it is the thing
// worth noticing before it becomes wrong. Nothing here stops anything.

/** Running a while — worth a look. */
export const TURN_LONG_MS = 10 * 60_000;
/** Running long enough that something is probably wrong. */
export const TURN_STUCK_MS = 30 * 60_000;
/** How often a view repaints to advance the colour. The counter that shows
 *  seconds ticks faster on its own; this is only for the colour steps. */
export const TURN_AGE_TICK_MS = 15_000;

/** The spinner colour for a turn that began at `startedAt` (epoch ms).
 *  No start time = magenta, the colour every spinner was before this existed:
 *  an unknown age must never read as a warning. */
export function turnAgeColor(startedAt?: number | null): string {
  if (startedAt == null || startedAt <= 0) return 'magenta';
  const age = Date.now() - startedAt;
  if (age >= TURN_STUCK_MS) return 'red';
  if (age >= TURN_LONG_MS) return 'yellow';
  return 'magenta';
}
