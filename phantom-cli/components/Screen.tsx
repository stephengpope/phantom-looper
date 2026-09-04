// The one shape every page in the TUI has. The margins above and below, the
// title, the blank line under it, the status line and the key footer with its
// gap all live HERE and nowhere else. Pages used to frame themselves and they
// drifted — two private copies of this, two more by hand, one footer mechanism
// in SelectList and another here, and the /model editor with none of it. A
// page that wants to look different has to argue with this file, not add a
// marginTop.
//
// Two rules this file enforces so pages cannot drift again:
//
// - ONE status line, always rendered (blank when quiet). error > notice >
//   busy > sub. Conditional lines used to appear and vanish, shifting
//   everything under them — the same layout-shift flicker the slash menu
//   fixed with fixed-height slots.
// - The page's row budget is computed HERE, from the chrome this file itself
//   renders, and handed down by context. Gemini CLI's settings dialog kept a
//   parallel height constant and it drifted from the real chrome — the budget
//   and the chrome must be one source.
import { Box, useBoxMetrics } from 'ink';
import { Text } from './Text.js';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/** One key the page answers to. `when: false` drops it from the footer, so
 *  a key that does not apply right now is not offered (bubbles' help-model
 *  rule: disabled bindings self-remove). */
export interface FooterKey { key: string; does: string; when?: boolean }

/** `[enter] change · [esc] close` — the ONE formatter for key hints, footers
 *  and the slash menu's help line alike. */
export const keyLine = (keys: FooterKey[]): string =>
  keys.filter((k) => k.when !== false).map((k) => `[${k.key}] ${k.does}`).join(' · ');

/** The terminal, as App measured it. Defaulted so a bare component in a test
 *  still lays out like a standard 80×24 terminal. */
export const SizeContext = createContext({ rows: 24, cols: 80 });

/** Rows a page's content may use inside Screen's chrome. Provided by Screen;
 *  the default matches a 24-row terminal for components rendered bare. */
export const BudgetContext = createContext(24 - CHROME_ROWS());

/** Every row this component renders around `children`: top margin, title,
 *  blank, status line, footer gap, footer, bottom margin. Counted from the
 *  JSX below and nowhere else. */
function CHROME_ROWS(): number { return 7; }

/** The last screen's natural content height. A mounting screen reads it once
 *  as its minHeight floor, so a tall list handing off to a short form keeps
 *  the frame and the footer never jumps. Natural (inner-box) height only —
 *  the padding never feeds back, so heights cannot ratchet. */
let lastContentRows = 0;

/** Test seam: forget the previous screen's height. */
export function resetScreenHeight() { lastContentRows = 0; }

export function Screen({ title, footer, sub, busy, notice, error, children }: {
  title: string;
  /** The keys that work here. Rendered by keyLine; `when: false` hides one. */
  footer?: FooterKey[];
  /** One dim line under the content — where a value lands, how to see more. */
  sub?: string;
  busy?: boolean;
  /** Something to know, in yellow. */
  notice?: string;
  /** Something that went wrong, in red. */
  error?: string;
  children?: ReactNode;
}) {
  // The floor is read ONCE at mount (it must not drop mid-screen); the memory
  // is updated from the measured inner box on every render.
  const body = useRef(null);
  const { height: contentRows, hasMeasured } = useBoxMetrics(body);
  const [floor] = useState(() => lastContentRows);
  useEffect(() => { if (hasMeasured) lastContentRows = contentRows; });
  // One line, one priority order. What matters most speaks; the rest waits.
  const status: { text: string; color?: string; dim?: boolean } =
    error ? { text: error, color: 'red' }
      : notice ? { text: notice, color: 'yellow' }
        : busy ? { text: 'working…', dim: true }
          : { text: sub ?? ' ', dim: true };
  const { rows } = useContext(SizeContext);
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text bold>{`  ${title}`}</Text>
      <Text> </Text>
      <BudgetContext.Provider value={Math.max(3, rows - CHROME_ROWS())}>
        <Box flexDirection="column" minHeight={Math.min(floor, Math.max(3, rows - CHROME_ROWS()))}>
          <Box ref={body} flexDirection="column" flexShrink={0}>
            {children}
          </Box>
        </Box>
      </BudgetContext.Provider>
      <Text color={status.color} dimColor={status.dim} wrap="truncate-end">{`  ${status.text || ' '}`}</Text>
      {/* Its own line, with a gap: pressed against the help above it the key
          list reads as one more sentence of that help. Always reserved, so a
          page gaining a footer never shifts its content. */}
      <Text> </Text>
      <Text dimColor wrap="truncate-end">{`  ${footer?.length ? keyLine(footer) : ' '}`}</Text>
    </Box>
  );
}
