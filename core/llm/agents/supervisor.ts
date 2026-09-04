// The supervisor — the looper's judge — in one place: its prompt stack and
// its kit shape.
//
// One free-form agent turn per round, in a direct conversation with the
// coding agent: read-only inspection tools on the coder's checkout, plus its
// two board powers (`kanban_card_move` — the run-ending verdict — and
// `kanban_card_items`), both bound to THE card. There is no forced-schema
// decision call: the verdict IS the tool call, and the loop breaks on the
// card's status change — never on the agent's word.
import { type Tool } from 'ai';
import { createAgent, type Agent, type ModelConfig } from '../createAgent.js';
import { withCurrentDate } from '../prompts/template.js';
import { systemPrompt } from '../prompts/supervisor/wiring.js';

export function supervisorInstructions(): string {
  return systemPrompt();
}

/** The supervisor's agent. `tools` is the kit the caller assembled — the
 *  readonly inspection preset + card read + web, and the loop's two bound
 *  board tools — capabilities, never loop mechanics. */
export function supervisorAgent(model: ModelConfig, tools: Record<string, Tool>, now = new Date()): Agent {
  return createAgent(model, {
    instructions: withCurrentDate(supervisorInstructions(), now),
    tools,
    maxSteps: 12,
  });
}
