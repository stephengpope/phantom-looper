// Session compaction. When a session's token usage approaches the model's
// context window, the oldest portion of the conversation is summarized into
// one message and the originals are removed. The summary sits at position 0
// in the history, tagged `summary: true`.
//
// Strategies are pluggable: each one controls how messages are serialized
// and what prompts the summarizer sees. `fast` ships now; others are added
// by registering a new object — no surgery required.
//
// The compactor is universal: it works on any agent's session (assistant,
// coding, supervisor). The caller wires it with the right settings and
// model config; the compactor knows nothing about Telegram, the CLI, or
// which agent is running.

import type { ModelMessage } from 'ai';

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export interface CompactionStrategy {
  readonly name: string;
  /**
   * Receives the full message slice being compacted (user, assistant, tool,
   * everything in that range) plus an optional prior summary (when position 0
   * was already a summary). Returns ready-to-send system and user prompts.
   *
   * The prior summary goes in `<prior-summary>`, never in `<conversation>`.
   */
  build(messages: ModelMessage[], priorSummary?: string): {
    system: string;
    prompt: string;
  };
}

// ---------------------------------------------------------------------------
// Fast strategy
// ---------------------------------------------------------------------------

const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [what the user is trying to accomplish]

## Important Details
- [constraints, decisions and why, facts, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, changes made, or "(none)"]

### Active
- [current work, partial changes, investigation state, or "(none)"]

### Blocked
- [blockers, failing commands, unknowns, or "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.
- Do not mention the summary process or that context was compacted.`;

const SYSTEM_PROMPT = `You are summarizing a conversation so another agent can continue the work.\n\n${SUMMARY_TEMPLATE}`;

const MERGE_INSTRUCTIONS = `The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent. Where they conflict, the conversation wins.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update accordingly.
- Update "Objective" and "Next Move" to reflect the current work state.`;

/** Serialize a message to plain text for the summarizer. */
function serializeMessage(m: ModelMessage): string | null {
  if (m.role === 'user' && typeof m.content === 'string') return `[User]: ${m.content}`;
  if (m.role === 'assistant') {
    if (typeof m.content === 'string') return `[Assistant]: ${m.content}`;
    if (Array.isArray(m.content)) {
      const texts = (m.content as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!);
      if (texts.length) return `[Assistant]: ${texts.join('\n')}`;
    }
  }
  return null;
}

const fastStrategy: CompactionStrategy = {
  name: 'fast',
  build(messages, priorSummary) {
    const lines = messages.map(serializeMessage).filter(Boolean) as string[];
    const conversation = lines.join('\n\n');

    let prompt: string;
    if (priorSummary) {
      prompt = [
        `Here is the conversation so far:\n\n<conversation>\n${conversation}\n</conversation>`,
        `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${priorSummary}\n</prior-summary>`,
        MERGE_INSTRUCTIONS,
      ].join('\n\n');
    } else {
      prompt = [
        `Here is the conversation so far:\n\n<conversation>\n${conversation}\n</conversation>`,
        'Create a summary from the conversation above so another agent can continue the work.',
      ].join('\n\n');
    }

    return { system: SYSTEM_PROMPT, prompt };
  },
};

// ---------------------------------------------------------------------------
// Strategy registry
// ---------------------------------------------------------------------------

const strategies = new Map<string, CompactionStrategy>();
strategies.set('fast', fastStrategy);

export function getStrategy(name: string): CompactionStrategy {
  const s = strategies.get(name);
  if (!s) throw new Error(`unknown compaction strategy: ${name} (available: ${[...strategies.keys()].join(', ')})`);
  return s;
}

export function registerStrategy(strategy: CompactionStrategy): void {
  strategies.set(strategy.name, strategy);
}

// ---------------------------------------------------------------------------
// Summary message tag
// ---------------------------------------------------------------------------

/** The tag on a compaction summary message in the history. */
export interface SummaryMeta {
  summary: true;
  strategy: string;
  /** ISO timestamp of when this summary was created. */
  compacted_at: string;
}

/** Check if a message is a compaction summary. */
export function isSummaryMessage(m: ModelMessage): boolean {
  return m.role === 'user' && (m as unknown as Record<string, unknown>).summary === true;
}

/** Get the text content of a summary message. */
export function summaryText(m: ModelMessage): string | null {
  if (!isSummaryMessage(m)) return null;
  return typeof m.content === 'string' ? m.content : null;
}

/** Build a tagged summary message. */
export function summaryMessage(text: string, strategy: string): ModelMessage {
  return {
    role: 'user',
    content: text,
    summary: true,
    strategy,
    compacted_at: new Date().toISOString(),
  } as unknown as ModelMessage;
}

// ---------------------------------------------------------------------------
// Compaction context and execution
// ---------------------------------------------------------------------------

export interface CompactionOpts {
  /** The live history array — mutated in place on success. */
  history: ModelMessage[];
  /** Which strategy to use. */
  strategy: CompactionStrategy;
  /** What % of user+assistant messages to summarize (0-100). */
  summarizePct: number;
  /** The LLM call. Abstracted so compaction has no dependency on helperCall,
   *  the database, or any server concept. The caller wires it. */
  call: (system: string, prompt: string) => Promise<string>;
  /** Called after the summary is spliced in. The caller rewrites the
   *  transcript, updates the session, etc. */
  onCompacted?: (opts: { summary: string; removed: number; removedMessages: ModelMessage[] }) => void;
  /** Called when the summary call fails — the history is untouched. */
  onFailed?: (err: Error) => void;
}

/**
 * Count user+assistant messages in the history. Returns pairs of
 * [count, indices] where indices are positions in the full array.
 */
function userAssistantIndices(history: ModelMessage[], startFrom: number): number[] {
  const out: number[] = [];
  for (let i = startFrom; i < history.length; i++) {
    const m = history[i];
    if (m.role === 'user' || m.role === 'assistant') out.push(i);
  }
  return out;
}

/**
 * Run compaction. Returns true if it kicked (async, background).
 * Returns false if there's nothing to compact.
 */
export function compact(opts: CompactionOpts): boolean {
  const { history, strategy, summarizePct } = opts;
  if (history.length === 0) return false;

  // Position 0 might be a prior summary — extract it, don't include in the
  // conversation being serialized.
  const hasPrior = isSummaryMessage(history[0]);
  const priorSummary = hasPrior ? summaryText(history[0]) ?? undefined : undefined;
  const startFrom = hasPrior ? 1 : 0;

  // Count user+assistant messages after the summary (if any).
  const uaIndices = userAssistantIndices(history, startFrom);
  if (uaIndices.length < 2) return false; // nothing meaningful to compact

  // Take the first summarizePct% of user+assistant messages.
  const takeCount = Math.max(1, Math.floor(uaIndices.length * summarizePct / 100));
  const lastUAIndex = uaIndices[takeCount - 1];

  // The removal range: everything from 0 to lastUAIndex (inclusive).
  // This includes the prior summary (if any), all user/assistant/tool
  // messages in between.
  const removeEnd = lastUAIndex + 1;
  const removedMessages = history.slice(0, removeEnd);

  // The messages the strategy receives: the removal range (full, including
  // tool messages). The strategy decides what to extract.
  const toSummarize = hasPrior ? removedMessages.slice(1) : removedMessages;

  if (toSummarize.length === 0) return false;

  const { system, prompt } = strategy.build(toSummarize, priorSummary);

  // Fire and forget — the caller's onCompacted handles persistence.
  void (async () => {
    try {
      const text = await opts.call(system, prompt);
      const trimmed = text.trim();
      if (!trimmed) throw new Error('the model returned an empty summary');

      const msg = summaryMessage(trimmed, strategy.name);
      history.splice(0, removeEnd, msg);
      opts.onCompacted?.({ summary: trimmed, removed: removeEnd, removedMessages });
    } catch (e) {
      opts.onFailed?.(e as Error);
    }
  })();

  return true;
}

/**
 * Should compaction fire? Compare the last turn's input tokens against
 * the threshold (a % of the model's context window).
 */
export function shouldCompact(lastInputTokens: number, contextWindow: number, pct: number): boolean {
  if (pct <= 0 || !Number.isFinite(pct)) return false;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  if (!Number.isFinite(lastInputTokens) || lastInputTokens <= 0) return false;
  const threshold = Math.floor(contextWindow * pct / 100);
  return lastInputTokens >= threshold;
}
