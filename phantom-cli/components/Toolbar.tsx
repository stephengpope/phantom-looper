// The one line under the typing area: the mode mark — '» plan mode on' or
// '» code mode on', ALWAYS shown while a session is on screen so you know which
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
// With no session (and nothing to say) nothing renders, not a reserved blank
// line: an empty row under the prompt reads as a rendering bug.
import { Box } from 'ink';
import Spinner from 'ink-spinner';
import { Text } from './Text.js';

/** One item on the line: plain text, or text with a severity mark — the
 *  colored • the /resume table and the board draw ahead of the git work state.
 *  The same shape as table.ts's Cell, so the three places cannot disagree. */
export type ToolbarPart = string | { text: string; mark: string };

export function Toolbar({ parts = [], spin, spinWho }: { parts?: ToolbarPart[]; spin?: string; spinWho?: string }) {
  const shown = parts.filter((p) => (typeof p === 'string' ? p : p.text));
  if (!shown.length && !spin) return null;
  return (
    <Box paddingLeft={2}>
      {shown.map((p, i) => (
        <Text key={i} color="yellow">
          {i > 0 ? ' · ' : ''}
          {typeof p === 'string' ? p : <><Text color={p.mark}>•</Text>{` ${p.text}`}</>}
        </Text>
      ))}
      {spin ? (<>
        {shown.length ? <Text color="yellow"> · </Text> : null}
        {spinWho ? <Text color="yellow">{`${spinWho} `}</Text> : null}
        <Text color="magenta"><Spinner type="dots" /></Text>
        <Text color="yellow">{` ${spin}`}</Text>
      </>) : null}
    </Box>
  );
}
