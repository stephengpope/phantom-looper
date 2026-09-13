// An inline yes/no. Renders in the overlay zone above the prompt: a title,
// an optional message, and [enter] / [esc]. Owns its own useInput — the
// prompt is inactive while this is up.
//
// Both voices get a left bar. An AGENT asking (`who` set) gets a cyan bar
// with "who: title" on one line, and its keys read approve/deny. The APP
// asking (no `who`) gets a red bar — it is a safety check, not a request.
import { Box, useInput } from 'ink';
import { Text } from './Text.js';
import { keyLine } from './Screen.js';

/** Rows the dialog draws with neither `who` nor `message`: the top margin,
 *  the title, the gap, the keys, the bottom margin. Each optional line adds
 *  one. */
export const CONFIRM_ROWS = 7;

export function Confirm({ title, message, who, onResult }: {
  title: string;
  message?: string;
  /** Who is asking, when it is an agent — `coding agent`. */
  who?: string;
  onResult: (yes: boolean) => void;
}) {
  useInput((_ch, key) => {
    if (key.return) onResult(true);
    else if (key.escape) onResult(false);
  });

  const color = who ? 'cyan' : 'red';
  const bar = <Text color={color}>{'▌ '}</Text>;

  const lines = [
    <Text key="title" bold>{who ? `${who}: ${title}` : title}</Text>,
    ...(message ? [<Text key="msg" dimColor>{message}</Text>] : []),
    <Text key="gap"> </Text>,
    <Text key="keys" dimColor>{keyLine([
      { key: 'enter', does: who ? 'approve' : 'confirm' },
      { key: 'esc', does: who ? 'deny' : 'cancel' },
    ])}</Text>,
  ];
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={1}>
      <Box>{bar}<Text> </Text></Box>
      {lines.map((l, i) => (
        <Box key={i}>
          {bar}
          {l}
        </Box>
      ))}
      <Box>{bar}<Text> </Text></Box>
    </Box>
  );
}
