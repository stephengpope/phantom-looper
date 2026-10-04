// Prompt caching. Anthropic allows 4 explicit breakpoints; other providers
// cache automatically and ignore the anthropic-namespaced options.
//
//  1–3. The first three system prompt blocks, one mark each. A frozen prompt
//       never moves, so these are cached across every turn of the session
//       (and across sessions when the block is identical — the base block).
//  4.   The rolling mark on the LAST conversation message, re-placed before
//       every step. Anthropic only looks ~20 blocks back from a mark, so a
//       mark left where the turn started goes stale once the tool loop grows.
//
// The marks go on COPIES, before each call. History and the transcript never
// carry them — a message with providerOptions is refused by the transcript.
import type { ModelMessage, SystemModelMessage } from 'ai';

/** How long Anthropic keeps a cached prefix alive. A person in a
 *  conversation outlasts the 5-minute default every time they step away; an hour costs
 *  2x the write rate on a delta of a few hundred tokens and saves rewriting
 *  the whole conversation. */
export const CACHE_TTL = '1h';
/** How many system blocks carry a mark: 4 allowed, 1 reserved for the
 *  conversation's rolling mark. */
export const CACHED_BLOCKS = 3;

const cacheControl = { anthropic: { cacheControl: { type: 'ephemeral' as const, ttl: CACHE_TTL } } };

/** The system prompt blocks as system messages: the first CACHED_BLOCKS
 *  marked, the rest bare. `uncached` says how many were left bare on a
 *  provider that honours the marks — the caller's one notice. */
export function systemMessages(blocks: readonly string[], provider: string): { messages: SystemModelMessage[]; uncached: number } {
  const messages = blocks.map((content, i): SystemModelMessage => (
    i < CACHED_BLOCKS
      ? { role: 'system', content, providerOptions: cacheControl }
      : { role: 'system', content }
  ));
  return { messages, uncached: provider === 'anthropic' ? Math.max(0, blocks.length - CACHED_BLOCKS) : 0 };
}

const unmark = (message: ModelMessage): ModelMessage => {
  if (!message.providerOptions?.anthropic) return message;
  const { anthropic: _stale, ...rest } = message.providerOptions;
  if (Object.keys(rest).length) return { ...message, providerOptions: rest };
  const { providerOptions: _drop, ...bare } = message;
  return bare;
};

const mark = (message: ModelMessage): ModelMessage => ({
  ...message, providerOptions: { ...message.providerOptions, ...cacheControl },
});

/** Copies of `messages` with the rolling mark on the last one and any stale
 *  mark removed (marks carry forward across steps; Anthropic caps at 4). */
export function withRollingCacheMark(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const out = messages.map(unmark);
  out[out.length - 1] = mark(out[out.length - 1]!);
  return out;
}
