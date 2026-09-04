// "⠹ Working… (44s · ↓ 1.7k tokens · thinking) · [esc] to interrupt" — Claude
// Code's shape: spinner (ink-spinner, as in Gemini CLI / Qwen Code /
// Nanocoder) + glimmering label, then ONE parenthetical with elapsed, output
// tokens so far, and the phase (thinking / writing / the tool that is
// running) — and the ONE key that acts on what this line describes, at the
// end of it. Stopping a turn belongs beside the turn, not under the prompt:
// the toolbar carries what is TRUE of the session (mode, tasks, card), never
// a running commentary. The thinking text
// itself is not drawn while it streams (ctrl+o if you want it) — this line's
// `thinking` is where that phase shows.
import { Box, useAnimation } from 'ink';
import { Text } from './Text.js';
import Spinner from 'ink-spinner';
import { Shimmer } from './Shimmer.js';
import { formatElapsed, formatTokens } from '../state.js';

export function StatusLine({ phase, startedAt, tokens = 0, escHint }: {
  /** `thinking`, `writing`, a tool name, or '' between parts. */
  phase: string; startedAt: number; tokens?: number;
  /** What esc does right now — it changes when lines are queued behind. */
  escHint?: string;
}) {
  // 1s tick just for the elapsed counter; the shimmer has its own cadence.
  useAnimation({ interval: 1000 });
  const bits = [formatElapsed(Date.now() - startedAt)];
  if (tokens > 0) bits.push(`↓ ${formatTokens(tokens)} tokens`);
  if (phase) bits.push(phase);
  return (
    <Box marginTop={1}>
      <Text color="magenta"><Spinner type="dots" /> </Text>
      <Shimmer text="Working…" color="#b48ead" shimmerColor="#ffffff" bold />
      <Text dimColor>{`  (${bits.join(' · ')})${escHint ? ` · ${escHint}` : ''}`}</Text>
    </Box>
  );
}
