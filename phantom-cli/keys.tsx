// `npm run keys` — press keys, see what your terminal actually sends and what
// the TUI will call them. The only way to know whether a chord reaches the
// app on THIS machine is to press it here. Same Ink, same parser as the TUI.
import { render, useInput, Box, useApp } from 'ink';
import { Text } from './components/Text.js';
import { useState } from 'react';

function Probe() {
  const { exit } = useApp();
  const [lines, setLines] = useState<string[]>([]);
  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') { exit(); return; }
    const mods = [key.ctrl && 'ctrl', key.shift && 'shift', key.meta && 'alt'].filter(Boolean).join('+');
    const named = (['upArrow', 'downArrow', 'leftArrow', 'rightArrow', 'tab', 'return', 'escape',
      'backspace', 'delete', 'pageUp', 'pageDown', 'home', 'end'] as const).find((k) => key[k]);
    const name = named ?? (ch ? JSON.stringify(ch) : '(nothing)');
    const label = mods ? `${mods}+${name}` : name;
    setLines((l) => [...l.slice(-14), label]);
  });
  return (
    <Box flexDirection="column">
      <Text>press any key — it prints what the TUI sees. ctrl+c quits.</Text>
      <Text> </Text>
      {lines.map((l, i) => <Text key={i}>{`  ${l}`}</Text>)}
    </Box>
  );
}

render(<Probe />, { exitOnCtrlC: false });
