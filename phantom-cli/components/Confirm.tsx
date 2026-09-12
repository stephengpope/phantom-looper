// An inline yes/no. Renders in the overlay zone above the prompt: a title,
// an optional message, and [enter] / [esc]. Owns its own useInput — the
// prompt is inactive while this is up.
//
// Two voices, told apart at a glance: the APP asking ("trash this for
// good?") is plain; an AGENT asking (`who` set) gets a cyan bar and a line
// naming the asker, and its keys read approve/deny — it is a request from
// someone working for you, not a safety check.
import { Box, useInput } from 'ink';
import { Text } from './Text.js';
import { keyLine } from './Screen.js';

export function Confirm({ title, message, who, onResult }: {
  title: string;
  message?: string;
  /** Who is asking, when it is an agent — `coding agent (my-branch)`. */
  who?: string;
  onResult: (yes: boolean) => void;
}) {
  useInput((_ch, key) => {
    if (key.return) onResult(true);
    else if (key.escape) onResult(false);
  });

  const lines = [
    ...(who ? [<Text key="who" color="cyan">{who} asks</Text>] : []),
    <Text key="title" bold>{title}</Text>,
    ...(message ? [<Text key="msg" dimColor>{message}</Text>] : []),
    <Text key="gap"> </Text>,
    <Text key="keys" dimColor>{keyLine([
      { key: 'enter', does: who ? 'approve' : 'confirm' },
      { key: 'esc', does: who ? 'deny' : 'cancel' },
    ])}</Text>,
  ];
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={who ? 1 : 2}>
      {lines.map((l, i) => (
        <Box key={i}>
          {who ? <Text color="cyan">{'▌ '}</Text> : null}
          {l}
        </Box>
      ))}
    </Box>
  );
}
