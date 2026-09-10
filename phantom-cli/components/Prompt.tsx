// The typing area: two solid rules (heavy, matching the divider) with a `>` prompt between them, pinned at
// the bottom. The bottom rule carries the app's name at its right end —
// `━━━━━ phantom-looper v0.1.6 ━━` (the running release; `[dev]` from a checkout), BBS-blue, with the Shimmer's glide running out
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
// no ctrl chord usable for anything. A big paste lands as a chip
// (`[Pasted #1 ~12 lines]`) whose text the WindowStore's PasteStore holds
// until submit swaps it back (paste.ts); multiline EDITING is still out of
// scope. Borders are top/bottom only, so the box stretches to the
// terminal width without ever wrapping.
import { Box, useBoxMetrics } from 'ink';
import { FixedText, Text } from './Text.js';
import { useEffect, useRef } from 'react';
import { TextInput } from './TextInput.js';
import { Glint } from './Shimmer.js';
import { APP_VERSION } from '../selfUpdate.js';
import type { PasteStore } from '../paste.js';

export function Prompt({ value, onChange, onSubmit, focus = true, onMeasure, pastes, onFileDrop, updateReady }: {
  value: string; onChange: (v: string) => void; onSubmit: (v: string) => void;
  pastes?: PasteStore;
  /** A paste that IS a dragged file's path (drop.ts) goes to the window as
   *  paths — it never lands in the box as text. */
  onFileDrop?: (paths: string[]) => void;
  /** The version a background auto-update installed: the label below swaps
   *  from this build's version to naming it until the launch that runs it. */
  updateReady?: string | null;
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
        {/* FixedText: the marker never shrinks, so the space after `>`
            survives the input wrapping (see Text.tsx). */}
        <FixedText color="cyan" bold>{'> '}</FixedText>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus={focus}
          placeholder="type a message…"
          pastes={pastes}
          onFileDrop={onFileDrop}
        />
      </Box>
      <Box>
        {/* The literal ━ runs are dim only — heavy comes from the glyph, as
            in Ink's borderStyle="bold"; bold+dim together renders BRIGHT on
            many terminals and made this corner glow beside the divider's ┫. */}
        <Box flexGrow={1} borderStyle="bold" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderDimColor />
        <Text dimColor>{' '}</Text>
        {/* One label, never two: this build's version, or — once a
            background auto-update has installed the next one — what is ready
            for the next launch, with the name dropped so it stands out.
            Same glint either way. */}
        <Glint text={updateReady
          ? `v${updateReady} is ready — runs next launch`
          : `phantom-looper ${APP_VERSION === 'dev' ? '[dev]' : `v${APP_VERSION}`}`}
          color="#5f87ff" shimmerColor="#b3ecff" bold
          active={process.stdout.isTTY === true} />
        <Text dimColor>{' ━━'}</Text>
      </Box>
    </Box>
  );
}
