// Glimmer: a bright 3-cell window sweeping across the label.
// Pattern from Letta Code's ShimmerText (the one OSS terminal shimmer):
// style at most three segments with chalk and emit ONE <Text> — per-character
// <Text> children destabilise Ink's wrapping on resize, and <Text bold={false}>
// does not emit SGR 22. Timing comes from Ink 7's useAnimation, which
// consolidates every animated component onto a single timer.
//
// Two variants: `Shimmer` sweeps continuously (the status line's "Working…" —
// motion IS the signal there), `Glint` sweeps once in a while (a brand label
// that must not nag). Glint keeps Shimmer's exact motion — constant
// velocity, TAIL-cell overshoot — and adds only randomness: the rest
// between sweeps and each direction's speed are drawn fresh every time, so
// nothing repeats on a fixed beat.
import chalk from 'chalk';
import { useAnimation } from 'ink';
import { Text } from './Text.js';
import { useEffect, useRef, useState } from 'react';

const TAIL = 6;        // cells the window travels past each end before wrapping
const WINDOW = 3;

const paint = (s: string, c: string, bold: boolean) =>
  s ? (bold ? chalk.bold(chalk.hex(c)(s)) : chalk.hex(c)(s)) : '';

const sweepText = (
  text: string, offset: number, color: string, shimmerColor: string, bold: boolean,
) => {
  const start = Math.max(0, offset);
  const end = Math.min(text.length, Math.max(start, offset + WINDOW));
  return paint(text.slice(0, start), color, bold)
    + paint(text.slice(start, end), shimmerColor, bold)
    + paint(text.slice(end), color, bold);
};

export function Shimmer({
  text, active = true, intervalMs = 50, color = '#8a8a8a', shimmerColor = '#ffffff', bold = false,
}: {
  text: string; active?: boolean; intervalMs?: number; color?: string; shimmerColor?: string; bold?: boolean;
}) {
  const { frame } = useAnimation({ interval: intervalMs, isActive: active });
  const cycle = text.length + TAIL * 2;
  const offset = (frame % cycle) - TAIL;
  return <Text>{active ? sweepText(text, offset, color, shimmerColor, bold) : paint(text, color, bold)}</Text>;
}

/** The Shimmer's own motion, once in a while instead of forever: out to the
 *  right and straight back, at constant velocity — Shimmer's zest IS the
 *  steady glide, so this adds no easing, no hold, nothing. Each direction
 *  rolls its own cell speed, from a flick to a lazy drift, so out and back
 *  rarely match. The window still overshoots the ends by TAIL cells, which
 *  is the whole feel of the turn: a beat off-label and it's back. (An eased
 *  version died here once: its slow zone landed in the off-label overshoot,
 *  so the glint vanished at the right edge and crawled back invisibly —
 *  easing plus overshoot reads as a stall, keep it linear.) Costs one
 *  setTimeout while resting — the animation timer only runs during the
 *  sweep. The first sweep comes quickly after mount so a fresh launch shows
 *  it; after that the rest period applies. */
/** Glint's clock, shared by the label and the block-art variant: roll a
 *  rest, sweep out and back at each leg's own speed, rest again. Returns
 *  the window's cell offset while sweeping, null while resting. */
function useGlintSweep(
  cycle: number, active: boolean,
  restMs: [number, number], cellMs: [number, number], firstRestMs: [number, number],
): number | null {
  const [legs, setLegs] = useState<[number, number] | null>(null);   // ms per cell, [out, back]; null = resting
  const first = useRef(true);
  useEffect(() => {
    if (!active || legs !== null) return;
    const [lo, hi] = first.current ? firstRestMs : restMs;
    first.current = false;
    const roll = () => cellMs[0] + Math.random() * (cellMs[1] - cellMs[0]);
    const t = setTimeout(() => setLegs([roll(), roll()]), lo + Math.random() * (hi - lo));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the ranges are config, not state
  }, [active, legs]);

  const sweeping = active && legs !== null;
  // isActive false→true resets time to 0, so each sweep starts from the left.
  const { time } = useAnimation({ interval: 33, isActive: sweeping });
  const [out, back] = legs ?? [1, 1];
  const outDur = cycle * out;
  useEffect(() => { if (sweeping && time >= outDur + cycle * back) setLegs(null); }, [sweeping, time, outDur, cycle, back]);

  if (!sweeping) return null;
  const cells = time < outDur ? time / out : cycle - (time - outDur) / back;
  return Math.round(Math.max(0, Math.min(cycle, cells))) - TAIL;
}

export function Glint({
  text, active = true, color = '#8a8a8a', shimmerColor = '#ffffff', bold = false,
  restMs = [3_000, 7_000], cellMs = [35, 90], firstRestMs = [1_000, 2_000],
}: {
  text: string; active?: boolean; color?: string; shimmerColor?: string; bold?: boolean;
  /** [min, max] quiet time between sweeps. */ restMs?: [number, number];
  /** [min, max] ms per cell — each direction rolls its own (Shimmer runs at 50). */ cellMs?: [number, number];
  /** [min, max] delay before the first sweep. */ firstRestMs?: [number, number];
}) {
  const offset = useGlintSweep(text.length + TAIL * 2, active, restMs, cellMs, firstRestMs);
  return <Text>{offset !== null ? sweepText(text, offset, color, shimmerColor, bold) : paint(text, color, bold)}</Text>;
}

/** The Glint over block art: the same window as one vertical band of light,
 *  every row swept at the same offset so the band glides across the shape —
 *  out, back, rest, exactly the label's motion. Rows keep their own base
 *  color (the banner's tints); each renders as ONE <Text> per the rule at
 *  the top of this file. */
export function GlintRows({
  rows, colors, active = true, shimmerColor = '#ffffff', bold = false,
  restMs = [3_000, 7_000], cellMs = [35, 90], firstRestMs = [1_000, 2_000],
}: {
  rows: string[]; colors: string[]; active?: boolean; shimmerColor?: string; bold?: boolean;
  restMs?: [number, number]; cellMs?: [number, number]; firstRestMs?: [number, number];
}) {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const offset = useGlintSweep(width + TAIL * 2, active, restMs, cellMs, firstRestMs);
  return (
    <>
      {rows.map((row, i) => (
        <Text key={i}>
          {offset !== null
            ? sweepText(row, offset, colors[i]!, shimmerColor, bold)
            : paint(row, colors[i]!, bold)}
        </Text>
      ))}
    </>
  );
}
