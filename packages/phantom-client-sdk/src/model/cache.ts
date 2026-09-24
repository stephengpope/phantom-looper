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

/** How long Anthropic keeps a cached prefix alive. A person driving the cli
 *  outlasts the 5-minute default every time they step away; an hour costs
 *  2x the write rate on a delta of a few hundred tokens and saves rewriting
 *  the whole conversation. */
export const CACHE_TTL = '1h';
/** How many system blocks carry a mark: 4 allowed, 1 reserved for the
 *  conversation's rolling mark. */
export const CACHED_BLOCKS = 3;

const cacheControl = { anthropic: { cacheControl: { type: 'ephemeral' as const, ttl: CACHE_TTL } } };

/** The system prompt blocks as system messages: the first CACHED_BLOCKS
 *  marked, the rest bare. */
export function systemMessages(blocks: readonly string[]): SystemModelMessage[] {
  return blocks.map((content, i) => (
    i < CACHED_BLOCKS
      ? { role: 'system', content, providerOptions: cacheControl }
      : { role: 'system', content }
  ));
}

const unmark = (m: ModelMessage): ModelMessage => {
  if (!m.providerOptions?.anthropic) return m;
  const { anthropic: _stale, ...rest } = m.providerOptions;
  if (Object.keys(rest).length) return { ...m, providerOptions: rest };
  const { providerOptions: _drop, ...bare } = m;
  return bare;
};

const mark = (m: ModelMessage): ModelMessage => ({
  ...m, providerOptions: { ...m.providerOptions, ...cacheControl },
});

/** Copies of `messages` with the rolling mark on the last one and any stale
 *  mark removed (marks carry forward across steps; Anthropic caps at 4). */
export function withRollingCacheMark(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const out = messages.map(unmark);
  out[out.length - 1] = mark(out[out.length - 1]!);
  return out;
}
