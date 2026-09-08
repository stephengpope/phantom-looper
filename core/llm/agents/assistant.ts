// The Assistant, in one place: its prompt stack and its kit. It lives in the
// TUI's side pane and is spoken to — voice is how you reach it, not its name.
//
// Prompt: prompts/assistant/assistant.ts systemPrompt — the whole prompt in
// one list, assembled when the voice engine starts and kept for its life (a
// restart is a fresh conversation, so a fresh prompt). The current date is
// appended at build, date only.
//
// Kit: the caller's — `session_*`, the full board kit, `screen_*`,
// `workspace_create_repo` (gated in the app), the web kit
// (core/llm/tools/tui.ts + web.ts), and the READ-ONLY workspace tools
// (read ls find grep — phantomTools pick:'readonly') scoped to the session
// on screen, rebuilt when the screen switches; the app supplies the
// handlers. The mutating file tools are deliberately not granted.
//
// Reasoning defaults to 'none' — the Assistant should be fast — but can be
// overridden via assistant_reasoning. createAgent turns 'none' into the
// lowest effort on a model that cannot stop thinking.
import type { Tool } from 'ai';
import { createAgent, type Agent, type ModelConfig } from '../createAgent.js';
import { withCurrentDate } from '../prompts/template.js';
import { systemPrompt } from '../prompts/assistant/wiring.js';

export function assistantInstructions(): string {
  return systemPrompt();
}

export function assistantAgent(
  model: ModelConfig, tools: Record<string, Tool>,
  opts?: { maxSteps?: number | null; now?: Date },
): Agent {
  const now = opts?.now ?? new Date();
  // Reasoning: if the caller (agentModelConfig) resolved one, use it;
  // otherwise default to 'none' for speed.
  const reasoning = model.reasoning ?? 'none';
  return createAgent(
    { ...model, reasoning },
    { instructions: withCurrentDate(assistantInstructions(), now), tools,
      maxSteps: opts?.maxSteps },
  );
}
