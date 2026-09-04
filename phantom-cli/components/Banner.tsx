// The launch splash: PHANTOM LOOPER in big block capitals, the label's own
// ice-to-blue tint running down the rows. Sessions with nothing said yet —
// boot's first and every /new — App drops it on the first interaction; a
// resume shows its history instead. It renders as the Pane's `fill`, centered in the
// empty space UNDER the session header, so the header is readable from the
// first frame and clearing the splash blanks only these rows — replacing
// the whole pane swapped 21 rows in one frame (traced), this blanks ~11.
// Two dead ends, both measured: per-content-growth erosion repaints the
// banner on every push-down; the full-pane swap is the 21-row flash.
// The font is hand-drawn 6×6 block capitals: no figlet dependency (the
// no-Ink-satellites rule), and only the letters these two words need. A
// pane too narrow for the big letters gets the plain label instead — block
// capitals that wrap read as garbage.
import chalk from 'chalk';
import { Box } from 'ink';
import { Text } from './Text.js';
import { GlintRows } from './Shimmer.js';

const FONT: Record<string, string[]> = {
  P: ['█████ ', '█    █', '█    █', '█████ ', '█     ', '█     '],
  H: ['█    █', '█    █', '█    █', '██████', '█    █', '█    █'],
  A: [' ████ ', '█    █', '█    █', '██████', '█    █', '█    █'],
  N: ['█    █', '██   █', '█ █  █', '█  █ █', '█   ██', '█    █'],
  T: ['██████', '  ██  ', '  ██  ', '  ██  ', '  ██  ', '  ██  '],
  O: [' ████ ', '█    █', '█    █', '█    █', '█    █', ' ████ '],
  M: ['█    █', '██  ██', '█ ██ █', '█    █', '█    █', '█    █'],
  L: ['█     ', '█     ', '█     ', '█     ', '█     ', '██████'],
  E: ['██████', '█     ', '█     ', '█████ ', '█     ', '██████'],
  R: ['█████ ', '█    █', '█    █', '█████ ', '█   █ ', '█    █'],
};

const word = (w: string): string[] =>
  Array.from({ length: 6 }, (_, r) => [...w].map((c) => FONT[c]![r]).join(' '));
const PHANTOM = word('PHANTOM');
const LOOPER = word('LOOPER');

// Row tints, ice down to blue — the Glint label's two colors with the stops
// between them. GlintRows asserts colors[i] per row, so each array matches
// its block's row count exactly: six for the letters, five for the emblem.
const TINTS = ['#b3ecff', '#a2d8ff', '#91c4ff', '#81afff', '#709bff', '#5f87ff'];
const MARK_TINTS = ['#b3ecff', '#9cd3ff', '#85baff', '#70a0ff', '#5f87ff'];

// The looper's emblem: an infinity sign, hand-drawn ANSI art — half-block
// arcs (▄▀) round the loops off, the inner walls lean in to a real crossing
// at the waist. Letter height, its own shape, so it reads as the mark under
// the wordmark. Each lobe is ~11 cells wide at the waist against 5 rows: a
// terminal cell is ~2:1 tall, so anything narrower reads as a vertical oval,
// not a loop. The outer walls step out one column at the waist and back in
// at the shoulders — that taper is what rounds the left and right ends. It glimmers with the label's own sweep (GlintRows — one
// band of light, the Glint's motion and colors), TTY-gated exactly as the
// Prompt's Glint is.
const INFINITY = [
  '  ▄██████▄   ▄██████▄  ',
  ' ██      ██ ██      ██ ',
  '██        ███        ██',
  ' ██      ██ ██      ██ ',
  '  ▀██████▀   ▀██████▀  ',
];

export function Banner({ width }: { width: number }) {
  const fits = width >= PHANTOM[0]!.length + 2;
  return (
    <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
      {fits ? (
        <>
          {PHANTOM.map((row, i) => <Text key={`p${i}`}>{chalk.bold(chalk.hex(TINTS[i]!)(row))}</Text>)}
          <Text> </Text>
          {LOOPER.map((row, i) => <Text key={`c${i}`}>{chalk.bold(chalk.hex(TINTS[i]!)(row))}</Text>)}
          <Text> </Text>
          <GlintRows rows={INFINITY} colors={MARK_TINTS} shimmerColor="#b3ecff" bold
            active={process.stdout.isTTY === true} />
        </>
      ) : (
        <Text>{chalk.bold(chalk.hex('#5f87ff')('Phantom Looper ∞'))}</Text>
      )}
    </Box>
  );
}
