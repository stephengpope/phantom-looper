// The Assistant, in one place: its prompt stack and its kit. It lives in the
// TUI's side pane and is spoken to — voice is how you reach it, not its name.
//
// Prompt: prompts/assistant/assistant.ts systemPrompt — the whole prompt in
// one list, assembled fresh at every start (the conversation resumes, the
// prompt is rebuilt — current date and all). The current date is appended at
// build, date only.
//
// Kit: the caller's — `session_*`, the full board kit, `screen_*`,
// `workspace_create_repo` (gated in the app), the web kit
// (core/llm/tools/tui.ts + web.ts), and the READ-ONLY workspace tools
// (read ls find grep task_list task_wait — phantomTools pick:'readonly')
// scoped to the session on screen, rebuilt when the screen switches; the
// app supplies the handlers. The mutating tools are deliberately not granted.
//
// Reasoning is whatever its config says (Settings.agentConfig: its own
// setting, else the coding agent's). PhantomAgent turns 'none' into the
// lowest effort on a model that cannot stop thinking.
import type { Tool } from 'ai';
import { PhantomAgent, type ModelConfig } from '../createAgent.js';
import { withCurrentDate } from '../prompts/template.js';
import { systemPrompt } from '../prompts/assistant/wiring.js';
import type { Clock } from '../../clock.js';

export function assistantInstructions(): string {
  return systemPrompt();
}

export class AssistantAgent extends PhantomAgent {
  constructor(
    model: ModelConfig, tools: Record<string, Tool>,
    opts: { sessionId: string | null; maxSteps?: number | null; clock: Clock },
  ) {
    super(model, opts.sessionId, {
      instructions: withCurrentDate(assistantInstructions(), opts.clock), tools,
      maxSteps: opts.maxSteps,
    });
  }
}
