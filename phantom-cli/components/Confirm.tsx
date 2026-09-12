// An inline confirmation dialog. Renders in the overlay zone above the
// prompt: a title, an optional message, and [enter] confirm / [esc] cancel.
// Owns its own useInput — the prompt is inactive while this is up.
import { Box, useInput } from 'ink';
import { Text } from './Text.js';
import { keyLine } from './Screen.js';

export function Confirm({ title, message, onResult }: {
  title: string;
  message?: string;
  onResult: (yes: boolean) => void;
}) {
  useInput((_ch, key) => {
    if (key.return) onResult(true);
    else if (key.escape) onResult(false);
  });

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={2}>
      <Text bold>{title}</Text>
      {message ? <Text dimColor>{message}</Text> : null}
      <Text> </Text>
      <Text dimColor>{keyLine([
        { key: 'enter', does: 'confirm' },
        { key: 'esc', does: 'cancel' },
      ])}</Text>
    </Box>
  );
}
