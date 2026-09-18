// Build an agent from the resolved config. Separate from agent.ts so the
// config chain has exactly one place where it turns into a running agent, and
// so /model can rebuild by calling this again. The resolution itself lives in
// core (agentConfig.ts — the same code the server's looper builds from); this
// file only adapts it to the app's Cfg shape.
import type { Tool } from 'ai';
import type { Agent } from '../core/llm/createAgent.js';
import { buildCodingAgent, agentModelConfig, agentMaxSteps, pinnedModel, sessionPin, type ModelPin } from '../core/llm/agentConfig.js';
import type { CodingPrompt } from '../core/llm/agents/coding.js';
import { AssistantAgent } from '../core/llm/agents/assistant.js';
import type { ConfigValue } from './config.js';

/** The resolved settings: the local file's seven merged with the server's. The
 *  builders TAKE it rather than reading it — a settings read is a network call
 *  now, and an agent build is not the place to discover the server is down. */
export type Cfg = Record<string, ConfigValue>;

export interface AgentSummary { provider: string; model: string; reasoning: string; maxSteps: number | null }

/** The coding agent for one session — every call it makes is billed to
 *  `sessionId`. `prompt` is the session's FROZEN prompt (its row's).
 *  `onRetry` receives each failed model attempt as it happens — App notes it
 *  into that session's conversation (the retry loop itself lives in core's
 *  languageModel; no caller wires its own). */
export function buildAgent(tools: Record<string, Tool>, cfg: Cfg, sessionId: string, prompt: CodingPrompt,
  onRetry?: (note: string) => void):
{ agent: Agent; summary: AgentSummary } {
  return buildCodingAgent(cfg, tools, sessionId, { prompt, onRetry });
}

/** The Assistant: its own provider/model/base_url/reasoning/max_steps, each
 *  cascading to the coding agent's while the provider matches (core
 *  agentModelConfig) — with ITS ROW's model laid over, like every other
 *  session (the pin freezes after its first turn). Reasoning defaults to
 *  'none' in the agent builder when no override is set. `own` is the
 *  assistant's session row, which exists before this is built: its calls are
 *  billed to it. Null before any session is on screen (no row yet). */
export function buildAssistantAgent(tools: Record<string, Tool>, cfg: Cfg, own: ({ id: string } & ModelPin) | null):
{ agent: Agent; summary: AgentSummary } {
  const model = pinnedModel(agentModelConfig(cfg, 'assistant'), cfg, sessionPin(own));
  const maxSteps = agentMaxSteps(cfg, 'assistant');
  return {
    agent: new AssistantAgent(model, tools, { sessionId: own?.id ?? null, maxSteps }),
    summary: { provider: model.provider, model: model.model,
      reasoning: model.reasoning ?? 'none', maxSteps },
  };
}
