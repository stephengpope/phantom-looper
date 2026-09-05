// The typing area: two solid rules (heavy, matching the divider) with a `>` prompt between them, pinned at
// the bottom. The bottom rule carries the app's name at its right end —
// `━━━━━ phantom-looper ━━`, BBS-blue, with the Shimmer's glide running out
// and back every few seconds, each direction at its own random speed
// (Glint in Shimmer.tsx) — drawn as our own row (Ink borders cannot
// hold text): a flexGrow Box whose only border is its top fills the left of
// the row with `━` at whatever width the pane has, the label follows. The box
// still costs exactly three rows, so the divider's ┫ junctions and onMeasure
// hold. The glint runs only on a real terminal: a pipe (tests, headless) gets
// the label static — ink-testing-library's fake stdout claims isTTY, so the
// check is on the process's own. Single-line editing on our own TextInput —
// ink-text-input inserted every key it did not recognise as literal text,
// which typed an `o` into the box each time ctrl+o toggled thinking and left
// no ctrl chord usable for anything. Multiline editing with paste
// placeholders is still out of scope; Ink 7 handles bracketed paste at the
// raw level. Borders are top/bottom only, so the box stretches to the
// terminal width without ever wrapping.
import { Box, useBoxMetrics } from 'ink';
import { Text } from './Text.js';
import { useEffect, useRef } from 'react';
import { TextInput } from './TextInput.js';
import { Glint } from './Shimmer.js';

export function Prompt({ value, onChange, onSubmit, focus = true, onMeasure }: {
  value: string; onChange: (v: string) => void; onSubmit: (v: string) => void;
  focus?: boolean;
  /** Where the box sits, as rows from the top of its parent (the top rule is
   *  that row, the bottom rule two below). The App aligns the divider's
   *  junctions to it. */
  onMeasure?: (top: number) => void;
}) {
  const ref = useRef(null);
  const { top, hasMeasured } = useBoxMetrics(ref);
  useEffect(() => { if (hasMeasured) onMeasure?.(top); }, [top, hasMeasured, onMeasure]);
  return (
    <Box
      ref={ref}
      flexDirection="column"
      marginTop={1}
      borderStyle="bold"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderDimColor
    >
      <Box>
        <Text color="cyan" bold>{'> '}</Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus={focus}
          placeholder="type a message…"
        />
      </Box>
      <Box>
        {/* The literal ━ runs are dim only — heavy comes from the glyph, as
            in Ink's borderStyle="bold"; bold+dim together renders BRIGHT on
            many terminals and made this corner glow beside the divider's ┫. */}
        <Box flexGrow={1} borderStyle="bold" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderDimColor />
        <Text dimColor>{' '}</Text>
        <Glint text="phantom-looper" color="#5f87ff" shimmerColor="#b3ecff" bold
          active={process.stdout.isTTY === true} />
        <Text dimColor>{' ━━'}</Text>
      </Box>
    </Box>
  );
}
