// The launch splash: a Pac-Man ghost in block art, royal blue dithering
// down to aqua the way pixel art does, the wordmark beneath it — the
// prompt's own Glint label, so it glimmers exactly as that one does.
// Sessions with nothing said yet — boot's first and every /new — App drops
// it on the first interaction; a resume shows its history instead. It
// renders as the Pane's `fill`, centered in the empty space UNDER the
// session header, so the header is readable from the first frame and
// clearing the splash blanks only these rows — replacing the whole pane
// swapped 21 rows in one frame (traced), this blanks ~11. Two dead ends,
// both measured: per-content-growth erosion repaints the banner on every
// push-down; the full-pane swap is the 21-row flash.
// The ghost is hand-drawn, no figlet dependency (the no-Ink-satellites
// rule). A pane too narrow for it gets the plain label instead — block art
// that wraps reads as garbage.
import chalk from 'chalk';
import { Box } from 'ink';
import { Text } from './Text.js';
import { Glint } from './Shimmer.js';

// The ghost as a cell grid, one letter per cell class, traced from a
// 22×27-pixel arcade ghost: a terminal cell is ~2:1 tall, so each pixel is
// ~1.5 columns by ~0.7 rows and the 34×20 grid keeps its proportions. The
// dome is a real half-circle (seven rows to full width, half blocks ▄
// rounding the first four); the eyes are 6×5 ovals with cut corners a third
// of the way down, the pupil a 3×2 black square at the right edge; the skirt
// is four legs with two-row V notches between them (▀ half blocks make the
// point and the taper). Eye edges are half blocks drawn on the BODY color as
// background, so the eye's corners round into the body instead of into
// the terminal's own background.
//   ' ' nothing   B body   b body ▄   t body ▀
//   W eye white   w eye white ▄ on body   v eye white ▀ on body
//   P pupil
const GHOST = [
  '             bbbbbbbb             ',
  '          bBBBBBBBBBBBBb          ',
  '       bBBBBBBBBBBBBBBBBBBb       ',
  '     bBBBBBBBBBBBBBBBBBBBBBBb     ',
  '   BBBBBBBBBBBBBBBBBBBBBBBBBBBB   ',
  '  BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB  ',
  ' BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB ',
  ' BBBBBBBBwWWwBBBBBBBBwWWwBBBBBBBB ',
  ' BBBBBBBWWWWWWBBBBBBWWWWWWBBBBBBB ',
  ' BBBBBBBWWWPPPBBBBBBWWWPPPBBBBBBB ',
  ' BBBBBBBWWWPPPBBBBBBWWWPPPBBBBBBB ',
  ' BBBBBBBBvWWvBBBBBBBBvWWvBBBBBBBB ',
  ' BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB ',
  ' BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB ',
  ' BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB ',
  ' BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB ',
  ' BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB ',
  ' BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB ',
  ' BBBBBBttBBBBBBBttBBBBBBBttBBBBBB ',
  ' BBBBt    tBBBt    tBBBt    tBBBB ',
];
const EYE = '#f8fcff';
const PUPIL = '#000000';
const GLYPH: Record<string, string> = { ' ': ' ', B: '█', b: '▄', t: '▀', W: '█', w: '▄', v: '▀', P: '█' };

// The body's color, row by row: six bands, royal blue at the crown down to
// pale aqua at the skirt, DITHERED between them the way pixel art blends — a
// shade glyph (░ ▒ ▓ = 25/50/75% foreground) drawn in the next band's color
// over the current band as background mixes the two inside one cell, and
// the speckle is the texture. `[glyph, from, to]`: solid rows use `from`
// alone. Half-block edges and the eye backgrounds take the row's dominant
// band (`to` on a ▓ row, `from` otherwise) so the outline stays crisp.
const C = ['#1230ff', '#1f5cff', '#2a8eff', '#3dc0ff', '#7fe9ff', '#b3f7ff'];
const BANDS: [string, string, string][] = [
  ['█', C[0]!, C[0]!],
  ['█', C[0]!, C[0]!],
  ['█', C[0]!, C[0]!],
  ['░', C[0]!, C[1]!],
  ['▒', C[0]!, C[1]!],
  ['▓', C[0]!, C[1]!],
  ['█', C[1]!, C[1]!],
  ['░', C[1]!, C[2]!],
  ['▒', C[1]!, C[2]!],
  ['▓', C[1]!, C[2]!],
  ['█', C[2]!, C[2]!],
  ['░', C[2]!, C[3]!],
  ['▒', C[2]!, C[3]!],
  ['▓', C[2]!, C[3]!],
  ['█', C[3]!, C[3]!],
  ['▒', C[3]!, C[4]!],
  ['█', C[4]!, C[4]!],
  ['▒', C[4]!, C[5]!],
  ['█', C[5]!, C[5]!],
  ['█', C[5]!, C[5]!],
];

/** One ghost row as a single styled string: runs of equal cells styled
 *  once each (few segments per row — the Shimmer file's rule for stable
 *  wrapping). Body cells take the row's band, dithered or solid; eye cells
 *  their own colors, with the half-block eye edges on the body's color. */
function ghostRow(row: string, [shade, from, to]: [string, string, string]): string {
  const body = shade === '▓' ? to : from;
  const style = (cls: string, n: number): string => {
    switch (cls) {
      case ' ': return ' '.repeat(n);
      case 'B': return shade === '█' ? chalk.hex(from)('█'.repeat(n)) : chalk.bgHex(from).hex(to)(shade.repeat(n));
      case 'W': return chalk.hex(EYE)('█'.repeat(n));
      case 'P': return chalk.hex(PUPIL)('█'.repeat(n));
      case 'w': case 'v': return chalk.bgHex(body).hex(EYE)(GLYPH[cls]!.repeat(n));
      default: return chalk.hex(body)(GLYPH[cls]!.repeat(n));
    }
  };
  let out = '';
  for (let i = 0; i < row.length;) {
    const cls = row[i]!;
    let j = i;
    while (j < row.length && row[j] === cls) j++;
    out += style(cls, j - i);
    i = j;
  }
  return out;
}

export function Banner({ width }: { width: number }) {
  const fits = width >= GHOST[0]!.length + 2;
  return (
    <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
      {fits ? (
        <>
          {GHOST.map((row, i) => <Text key={`g${i}`}>{ghostRow(row, BANDS[i]!)}</Text>)}
          <Text> </Text>
          <Glint text="phantom-looper" color="#5f87ff" shimmerColor="#b3ecff" bold
            active={process.stdout.isTTY === true} />
        </>
      ) : (
        <Text>{chalk.bold(chalk.hex('#5f87ff')('Phantom Looper ∞'))}</Text>
      )}
    </Box>
  );
}
