// The coding agent, in one place: its prompt stack and its kit.
//
// Prompt: prompts/coding/wiring.ts codingPrompt — two pieces, built once
// when the session is created and FROZEN on its row (sessions.system_prompt).
// Every build sends the stored pieces verbatim; editing a prompt file
// changes new sessions only. Time never enters the frozen text: the current
// date — date only, Shockwave's rule — is appended to the workspace piece at
// every agent build.
//
// Prompt caching: each piece is one system block with an Anthropic cache
// breakpoint — the base piece is identical across all workspaces and
// sessions, the workspace piece varies by skills/secrets/credentials — plus
// the last conversation message: 3 of 4 allowed. Other providers ignore the
// Anthropic-namespaced options and cache automatically.
//
// Kit: the caller's — the file and task tools + skills + web + secrets +
// `kanban_card_read` (bound to the session's own workspace) and, inside a
// loop run, `kanban_card_block`. The caller builds them all (they need the
// server, the session id, and — for the board — the window) and hands them in.
import type { SystemModelMessage, Tool } from 'ai';
import { PhantomAgent, CACHE_TTL, type ModelConfig } from '../createAgent.js';
import { withCurrentDate } from '../prompts/template.js';
import type { CodingPrompt } from '../prompts/coding/wiring.js';
import type { Clock } from '../../clock.js';

export { codingPrompt, type CodingPrompt } from '../prompts/coding/wiring.js';

/** The two stored pieces as the two cached system blocks. */
function systemBlocks(prompt: CodingPrompt, clock: Clock): SystemModelMessage[] {
  const cacheControl = { anthropic: { cacheControl: { type: 'ephemeral' as const, ttl: CACHE_TTL } } };
  return [
    { role: 'system', content: prompt.base, providerOptions: cacheControl },
    { role: 'system', content: withCurrentDate(prompt.workspace, clock), providerOptions: cacheControl },
  ];
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
