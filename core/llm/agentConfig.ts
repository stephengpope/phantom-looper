// The SHAPE of an agent's runtime configuration — what the LLM layer needs to
// run one agent, and nothing about where it came from. The server's settings
// domain (phantom-backend/agentConfig.ts, through Settings.agentConfig) is
// the one place that fills it: cascade, the session's pinned model, the
// provider's key, compaction. Nothing in core/llm reads a setting by name.
import type { Tool } from 'ai';
import type { Agent, ModelConfig } from './createAgent.js';
import type { CompactionConfig } from './compaction.js';
import { CodingAgent, type CodingPrompt } from './agents/coding.js';
import { Clock } from '../clock.js';

export type AgentName = 'coding' | 'assistant' | 'supervisor';
export const AGENT_NAMES: readonly AgentName[] = ['coding', 'assistant', 'supervisor'];
export const isAgentName = (s: string): s is AgentName => (AGENT_NAMES as readonly string[]).includes(s);

export interface AgentConfig {
  agent: AgentName;
  /** The model the agent runs on — provider, model, endpoint, key, reasoning. */
  model: ModelConfig;
  /** Steps per turn; null = unlimited. */
  maxSteps: number | null;
  /** When and how its history is summarized, and the model that writes the summary. */
  compaction: CompactionConfig;
  /** The builder's zone (the `timezone` setting) — what "Current date" in
   *  the agent's prompt is read in. A string, not a Clock: this config
   *  crosses the wire to the cli. */
  timezone: string;
}

/** The one-line summary the cli's banner and toolbar draw. */
export interface AgentSummary { provider: string; model: string; reasoning: string; maxSteps: number | null }

/** The builder's clock for an agent built from this config. */
export const agentClock = (c: AgentConfig): Clock => new Clock(c.timezone);

export const agentSummary = (c: AgentConfig): AgentSummary => ({
  provider: c.model.provider || 'unset', model: c.model.model || 'unset',
  reasoning: c.model.reasoning ?? '', maxSteps: c.maxSteps,
});

/** The coding agent from its resolved config, for one session. `prompt` is
 *  the session's FROZEN system prompt (its row's). `onRetry` receives each
 *  failed model attempt as it happens (withRetry). Every call the agent makes
 *  is billed to `sessionId`. */
export function buildCodingAgent(
  cfg: AgentConfig, tools: Record<string, Tool>, sessionId: string,
  o: { prompt: CodingPrompt; modelFetch?: typeof fetch; onRetry?: (note: string) => void },
): { agent: Agent; summary: AgentSummary } {
  const model: ModelConfig = { ...cfg.model };
  if (o.modelFetch) model.fetch = o.modelFetch;
  if (o.onRetry) model.onRetry = o.onRetry;
  return {
    agent: new CodingAgent(model, tools, { sessionId, maxSteps: cfg.maxSteps, prompt: o.prompt, clock: agentClock(cfg) }),
    summary: agentSummary(cfg),
  };
}
