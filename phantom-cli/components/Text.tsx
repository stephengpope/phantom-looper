// The app's Text: Ink's, with the one cleaning every drawn character goes
// through. Ink measures a tab as ZERO cells (string-width) while a terminal
// advances it to the next tab stop, so a row holding a tab is drawn wider than
// Ink laid it out — with two panes on every row it pushed the voice pane past
// the terminal edge, the row wrapped, and Ink's relative cursor moves put every
// row below it one line low: the toolbar and prompt vanished, the status line
// drew twice (2026-09-02, `git remote -v` in a tool result). Other control
// characters break a row the same way (`\r` returns to column 0 mid-row).
//
// Cleaning happens HERE, before Ink measures, so a tab becomes real spaces and
// the layout stays right. No file in the app imports Ink's Text directly —
// Text.test.tsx scans the tree — so nothing can bypass this.
import { Text as InkText } from 'ink';
import type { ComponentProps, ReactNode } from 'react';

const TAB = 8;
/** Anything the terminal would act on rather than print: C0 controls other
 *  than newline and ESC (Ink keeps SGR colours and strips the rest itself),
 *  DEL, and the C1 range. */
const CONTROL = /[\x00-\x09\x0b-\x1a\x1c-\x1f\x7f-\x9f]/;

/** Tabs expanded to `TAB`-column stops (per line, so aligned output stays
 *  aligned), every other control character dropped. */
export function screenText(s: string): string {
  if (!CONTROL.test(s)) return s;
  let out = '';
  let col = 0;
  for (const ch of s) {
    if (ch === '\t') { const n = TAB - (col % TAB); out += ' '.repeat(n); col += n; }
    else if (ch === '\n') { out += ch; col = 0; }
    else if (CONTROL.test(ch)) continue;
    else { out += ch; col++; }
  }
  return out;
}

function clean(node: ReactNode): ReactNode {
  if (typeof node === 'string') return screenText(node);
  if (Array.isArray(node)) return node.map(clean);
  return node;
}

export function Text(props: ComponentProps<typeof InkText>) {
  return <InkText {...props}>{clean(props.children)}</InkText>;
}
