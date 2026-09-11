// The one line under the typing area: the mode mark — '» planning' or
// '» coding', ALWAYS shown while a session is on screen so you know which
// before you type — with the transient notices (ctrl+c's "again to quit")
// composed after it by App. Padded two cells to clear the `> ` prompt gutter
// above it.
//
// `spin` is the session working somewhere else (the loop's turn, another
// window): who is working, the spinner, and ONE word for the work —
// `coding agent ⠹ planning`; `spinWho` is dropped when the holder is not one
// of our agents, leaving `⠹ macbook-pro`. A spinner is how every other
// running thing on this screen looks, so the line needs no sentence
// explaining that you cannot type; the refusal says that if you try.
//
// The row is ALWAYS held, blank when there is nothing to say: appearing and
// vanishing moved the prompt on boot (the line lands only once the session
// seats), and a held blank row costs nothing next to a page that bounces.
import { Box } from 'ink';
import Spinner from 'ink-spinner';
import { useContext } from 'react';
import { turnAgeColor } from '../turnAge.js';
import { SizeContext } from './Screen.js';
import { Text } from './Text.js';

/** One item on the line: plain text, or text with a severity mark — the
 *  colored • the /resume table and the board draw ahead of the git work state.
 *  The same shape as table.ts's Cell, so the three places cannot disagree. */
export type ToolbarPart = string | { text: string; mark: string };

/** Parts that belong together — the card and its git dot, the model and its
 *  token meter. A group joins its parts with a bare space so they read as ONE
 *  fact (`PHA-7 • not pushed`, `gpt-5 12.4k ↓`); the heavier ` · ` is kept for
 *  between groups, so the eye parses facts, not a flat list of fields. */
export type ToolbarGroup = ToolbarPart[];

export function Toolbar({ groups = [], spin, spinWho, spinSince, toast }: {
  groups?: ToolbarGroup[]; spin?: string; spinWho?: string;
  /** When the running turn began (epoch ms), so the spinner can age. */
  spinSince?: number;
  /** A timed message overriding the normal content — white text on a colored
   *  background (the `bg` field). Auto-dismissed by the caller's timer. */
  toast?: { text: string; bg: string } }) {
  const { cols } = useContext(SizeContext);
  if (toast) return (
    <Box paddingLeft={2} width={cols} overflow="hidden"><Text backgroundColor={toast.bg} color="white" bold>{` ${toast.text} `}</Text></Box>
  );
  const shown = groups
    .map((g) => g.filter((p) => (typeof p === 'string' ? p : p.text)))
    .filter((g) => g.length);
  if (!shown.length && !spin) return (
    // The held blank row — same shape as the real line, one cell of content
    // so yoga keeps the height.
    <Box paddingLeft={2} width={cols} overflow="hidden"><Text> </Text></Box>
  );
  return (
    <Box paddingLeft={2} width={cols} overflow="hidden">
      <Text color="yellow">» </Text>
      {shown.map((g, gi) => (
        <Text key={gi} color="yellow">
          {gi > 0 ? ' · ' : ''}
          {g.map((p, pi) => (
            <Text key={pi} color="yellow">
              {pi > 0 ? ' ' : ''}
              {typeof p === 'string' ? p : <><Text color={p.mark}>•</Text>{` ${p.text}`}</>}
            </Text>
          ))}
        </Text>
      ))}
      {spin ? (<>
        {shown.length ? <Text color="yellow"> · </Text> : null}
        {spinWho ? <Text color="yellow">{`${spinWho} `}</Text> : null}
        <Text color={turnAgeColor(spinSince)}><Spinner type="dots" /></Text>
        <Text color="yellow">{` ${spin}`}</Text>
      </>) : null}
    </Box>
  );
}
