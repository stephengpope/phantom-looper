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
// Reasoning is pinned to 'none' — the Assistant must not sit and think
// between turns; createAgent turns that into the lowest effort on a model
// that cannot stop thinking.
import type { Tool } from 'ai';
import { createAgent, type Agent, type ModelConfig } from '../createAgent.js';
import { withCurrentDate } from '../prompts/template.js';
import { systemPrompt } from '../prompts/assistant/wiring.js';

export function assistantInstructions(): string {
  return systemPrompt();
}

export function assistantAgent(model: ModelConfig, tools: Record<string, Tool>, now = new Date()): Agent {
  return createAgent(
    { ...model, reasoning: 'none' },
    // Same date rule as the coding agent: date only, appended at build (the
    // Assistant's prompt is rebuilt at every engine start and model change).
    { instructions: withCurrentDate(assistantInstructions(), now), tools, maxSteps: 10 },
  );
}
