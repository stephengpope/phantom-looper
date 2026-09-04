// Build an agent from the resolved config. Separate from agent.ts so the
// config chain has exactly one place where it turns into a running agent, and
// so /model can rebuild by calling this again. The resolution itself lives in
// core (agentConfig.ts — the same code the server's looper builds from); this
// file only adapts it to the app's Cfg shape.
import type { Tool } from 'ai';
import type { Agent } from '../core/llm/createAgent.js';
import { buildCodingAgent, agentModelConfig } from '../core/llm/agentConfig.js';
import { codingInstructions } from '../core/llm/agents/coding.js';
import { assistantAgent } from '../core/llm/agents/assistant.js';
import type { ConfigValue } from './config.js';

/** The resolved settings: the local file's seven merged with the server's. The
 *  builders TAKE it rather than reading it — a settings read is a network call
 *  now, and an agent build is not the place to discover the server is down. */
export type Cfg = Record<string, ConfigValue>;

export interface AgentSummary { provider: string; model: string; reasoning: string; maxSteps: number | null }

/** The coding agent. `instructions` is the session's FROZEN prompt (from its
 *  transcript header); absent — a brand-new session — a fresh stack is
 *  assembled, and the caller stores what `codingInstructions()` returned.
 *  `onRetry` receives each failed model attempt as it happens — App notes it
 *  into that session's conversation (the retry loop itself lives in core's
 *  languageModel; no caller wires its own). */
export function buildAgent(tools: Record<string, Tool>, cfg: Cfg, instructions?: string,
  onRetry?: (note: string) => void):
{ agent: Agent; summary: AgentSummary } {
  return buildCodingAgent(cfg, tools, instructions, undefined, onRetry);
}

export { codingInstructions };

/** The Assistant: its own provider/model/base_url trio, each cascading to the
 *  coding agent's while the provider matches (core agentModelConfig — a
 *  provider override with no model throws, surfaced as the build notice). The
 *  prompt stack, the reasoning pin and the step cap live in
 *  core/llm/agents/assistant.ts; the tools are what the app lets it do. */
export function buildAssistantAgent(tools: Record<string, Tool>, cfg: Cfg):
{ agent: Agent; summary: AgentSummary } {
  const model = agentModelConfig(cfg, 'assistant');
  return {
    agent: assistantAgent(model, tools),
    summary: { provider: model.provider, model: model.model, reasoning: 'none', maxSteps: 10 },
  };
}
