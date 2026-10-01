// The coding agent on the OLD path (core/llm — goes with the cli switch).
//
// Prompt: the row's stored sections (phantom-client-sdk/systemPrompt),
// assembled once when the session was created. Sent as stored, one cache
// mark per section, plus the last conversation message.
//
// Kit: the caller's — the file and task tools + skills + web + secrets +
// `kanban_card_read` (bound to the session's own project) and, inside a
// card run, `kanban_card_block`. The caller builds them all (they need the
// server, the session id, and — for the board — the window) and hands them in.
import type { SystemModelMessage, Tool } from 'ai';
import { PhantomAgent, CACHE_TTL, type ModelConfig } from '../createAgent.js';
import type { Clock } from '../../clock.js';
import { systemPromptBlocks, type StoredSystemPrompt } from 'phantom-client-sdk/systemPrompt';

/** The old path (core/llm) on the new row: the stored prompt, as it stands.
 *  The date is in the volatile section since the session was created. */
export type CodingPrompt = StoredSystemPrompt;
export const codingPrompt = (): CodingPrompt => ({ stable: '', context: '', volatile: '' });

/** The stored sections as the cached system blocks. */
function systemBlocks(prompt: CodingPrompt, _clock: Clock): SystemModelMessage[] {
  const cacheControl = { anthropic: { cacheControl: { type: 'ephemeral' as const, ttl: CACHE_TTL } } };
  return systemPromptBlocks(prompt).map((content) => ({ role: 'system' as const, content, providerOptions: cacheControl }));
}

export class CodingAgent extends PhantomAgent {
  constructor(
    model: ModelConfig,
    tools: Record<string, Tool>,
    opts: { sessionId: string | null; maxSteps?: number | null; prompt: CodingPrompt; clock: Clock },
  ) {
    super(model, opts.sessionId, {
      instructions: systemBlocks(opts.prompt, opts.clock),
      tools,
      maxSteps: opts.maxSteps,
    });
  }
}
