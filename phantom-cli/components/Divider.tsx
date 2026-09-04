// The vertical rule between the conversation and the voice pane: one column,
// one glyph per row, drawn by us rather than as a box border. A border belongs
// to one box and knows nothing of its neighbours, so the prompt's horizontal
// rules could only ever run into a plain bar; owning the column lets the rows
// they meet show a junction. `junctions` are screen rows (the App measures
// where the prompt is and passes them in), so they follow the prompt when the
// toolbar notice or the command menu shifts it. Heavy glyphs: the thin `│`
// leaves a visible gap between rows in many terminal fonts.
import { Box } from 'ink';
import { Text } from './Text.js';

export function Divider({ rows, junctions }: { rows: number; junctions: readonly number[] }) {
  const lines = Array.from({ length: rows }, (_, i) => (junctions.includes(i) ? '┫' : '┃')).join('\n');
  return (
    <Box width={1} flexShrink={0} flexDirection="column">
      <Text dimColor>{lines}</Text>
    </Box>
  );
}
