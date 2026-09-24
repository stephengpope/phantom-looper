// Compaction: when a conversation nears the model's context window, the
// oldest part is summarized by a small model and replaced, in memory, by
// one summary message. The record is NOT rewritten: one `compaction` line
// is appended — the summary and the id of the first line still kept — and
// loading rebuilds the conversation from it (transcript.ts conversationFrom).
//
// Strategies are pluggable: `fast` ships; another is registered by name.
// The compactor knows nothing about which agent or host is running it.
import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import { PhantomError } from './errors.js';

export interface CompactionStrategy {
  readonly name: string;
  /** The prompts for summarizing `messages`, folding in the prior summary
   *  when the conversation already opens with one. */
  build(messages: ModelMessage[], priorSummary?: string): { system: string; prompt: string };
}

// ── the fast strategy ─────────────────────────────────────────────────────

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

function serializeMessage(m: ModelMessage): string | null {
  if (m.role === 'user' && typeof m.content === 'string') return `[User]: ${m.content}`;
  if (m.role === 'assistant') {
    if (typeof m.content === 'string') return `[Assistant]: ${m.content}`;
    const texts = (m.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text' && b.text).map((b) => b.text!);
    if (texts.length) return `[Assistant]: ${texts.join('\n')}`;
  }
  return null;
}

export const fastStrategy: CompactionStrategy = {
  name: 'fast',
  build(messages, priorSummary) {
    const conversation = messages.map(serializeMessage).filter(Boolean).join('\n\n');
    const prompt = priorSummary
      ? [
        `Here is the conversation so far:\n\n<conversation>\n${conversation}\n</conversation>`,
        `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${priorSummary}\n</prior-summary>`,
        MERGE_INSTRUCTIONS,
      ].join('\n\n')
      : [
        `Here is the conversation so far:\n\n<conversation>\n${conversation}\n</conversation>`,
        'Create a summary from the conversation above so another agent can continue the work.',
      ].join('\n\n');
    return { system: SYSTEM_PROMPT, prompt };
  },
};

const strategies = new Map<string, CompactionStrategy>([[fastStrategy.name, fastStrategy]]);

export function compactionStrategy(name: string): CompactionStrategy {
  const s = strategies.get(name);
  if (!s) throw new PhantomError('config_invalid', `unknown compaction strategy "${name}" (have: ${[...strategies.keys()].join(', ')})`);
  return s;
}
export function registerCompactionStrategy(s: CompactionStrategy): void { strategies.set(s.name, s); }

// ── when ──────────────────────────────────────────────────────────────────

export function compactionDue(lastInputTokens: number, contextWindow: number | null, thresholdPct: number): boolean {
  if (contextWindow == null || contextWindow <= 0) return false;
  if (thresholdPct <= 0 || !Number.isFinite(thresholdPct)) return false;
  if (!Number.isFinite(lastInputTokens) || lastInputTokens <= 0) return false;
  return lastInputTokens >= Math.floor(contextWindow * thresholdPct / 100);
}

// ── what ──────────────────────────────────────────────────────────────────

export interface CompactionPlan {
  system: string;
  prompt: string;
  /** How many messages from the front are replaced by the summary. */
  removeCount: number;
}

/** Which prefix of `messages` to summarize. `priorSummary` is the text of
 *  the summary the conversation opens with, when it does (the loader put it
 *  at index 0). Null when there is too little to compact. */
export function planCompaction(
  messages: readonly ModelMessage[], strategy: CompactionStrategy, summarizePct: number, priorSummary: string | null,
): CompactionPlan | null {
  const startFrom = priorSummary === null ? 0 : 1;
  const ua: number[] = [];
  for (let i = startFrom; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'user' || m.role === 'assistant') ua.push(i);
  }
  if (ua.length < 2) return null;
  const takeCount = Math.max(1, Math.floor(ua.length * summarizePct / 100));
  const removeCount = ua[takeCount - 1]! + 1;
  const toSummarize = messages.slice(startFrom, removeCount);
  if (!toSummarize.length) return null;
  const { system, prompt } = strategy.build(toSummarize, priorSummary ?? undefined);
  return { system, prompt, removeCount };
}

/** The summary call. Throws compaction_failed. */
export async function writeSummary(model: LanguageModel, plan: CompactionPlan, maxTokens: number | null): Promise<string> {
  let text: string;
  try {
    ({ text } = await generateText({
      model, maxRetries: 0, system: plan.system, prompt: plan.prompt,
      ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
    }));
  } catch (e) {
    throw new PhantomError('compaction_failed', `the summary call failed: ${(e as Error).message}`, { cause: e });
  }
  const trimmed = text.trim();
  if (!trimmed) throw new PhantomError('compaction_failed', 'the model returned an empty summary');
  return trimmed;
}
