// `npm run keys` — press keys, see what your terminal actually sends and what
// the TUI will call them. The only way to know whether a chord reaches the
// app on THIS machine is to press it here. Same Ink, same parser as the TUI.
import { render, useInput, Box, useApp } from 'ink';
import { Text } from './components/Text.js';
import { useState } from 'react';

function Probe() {
  const { exit } = useApp();
  const [lines, setLines] = useState<string[]>([]);
  useInput((char, key) => {
    if (key.ctrl && char === 'c') { exit(); return; }
    const mods = [key.ctrl && 'ctrl', key.shift && 'shift', key.meta && 'alt'].filter(Boolean).join('+');
    const named = (['upArrow', 'downArrow', 'leftArrow', 'rightArrow', 'tab', 'return', 'escape',
      'backspace', 'delete', 'pageUp', 'pageDown', 'home', 'end'] as const).find((name) => key[name]);
    const name = named ?? (char ? JSON.stringify(char) : '(nothing)');
    const label = mods ? `${mods}+${name}` : name;
    setLines((line) => [...line.slice(-14), label]);
  });
  return (
    <Box flexDirection="column">
      <Text>press any key — it prints what the TUI sees. ctrl+c quits.</Text>
      <Text> </Text>
      {lines.map((line, i) => <Text key={i}>{`  ${line}`}</Text>)}
    </Box>
  );
}

render(<Probe />, { exitOnCtrlC: false });
