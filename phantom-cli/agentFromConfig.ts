// Config → agent, for the cli. The RESOLUTION is the server's
// (Settings.agentConfig, served on GET /agents/:agent/config): cascade, the
// session's pinned model, the provider's key, compaction — the same answer
// the server's own turns run on. The cli holds no copy of any of it; this
// file fetches the finished config and hands it to core's builders, and
// every screen that draws a model reads the summary that comes back.
import type { Tool } from 'ai';
import type { Agent } from '../core/llm/createAgent.js';
import { buildCodingAgent, agentSummary, agentClock, type AgentConfig, type AgentName, type AgentSummary } from '../core/llm/agentConfig.js';
import type { CodingPrompt } from '../core/llm/agents/coding.js';
import { AssistantAgent } from '../core/llm/agents/assistant.js';
import type { Api } from './request.js';

export type { AgentConfig, AgentSummary };

/** THE read: an agent's config from the server. `session` applies that
 *  row's pinned model and its workspace's overrides. Throws with the server's
 *  message when the settings cannot build the agent (a half-set pair) — the
 *  caller says so rather than guessing a model. */
export function agentConfigFor(api: Api, agent: AgentName, scope: { session?: string; workspace?: string } = {}): Promise<AgentConfig> {
  const q = scope.session ? `?session=${encodeURIComponent(scope.session)}`
    : scope.workspace ? `?workspace=${encodeURIComponent(scope.workspace)}` : '';
  return api('GET', `/agents/${agent}/config${q}`) as Promise<AgentConfig>;
}

/** The coding agent for one session — every call it makes is billed to
 *  `sessionId`. `prompt` is the session's FROZEN prompt (its row's).
 *  `onRetry` receives each failed model attempt as it happens — App notes it
 *  into that session's conversation (the retry loop itself lives in core's
 *  languageModel; no caller wires its own). */
export function buildAgent(tools: Record<string, Tool>, cfg: AgentConfig, sessionId: string, prompt: CodingPrompt,
  onRetry?: (note: string) => void):
{ agent: Agent; summary: AgentSummary } {
  return buildCodingAgent(cfg, tools, sessionId, { prompt, onRetry });
}

/** The Assistant from its config. `own` is the assistant's session row,
 *  which exists before this is built: its calls are billed to it. Null
 *  before any session is on screen (no row yet). */
export function buildAssistantAgent(tools: Record<string, Tool>, cfg: AgentConfig, own: { id: string } | null):
{ agent: Agent; summary: AgentSummary } {
  return {
    agent: new AssistantAgent(cfg.model, tools, { sessionId: own?.id ?? null, maxSteps: cfg.maxSteps, clock: agentClock(cfg) }),
    summary: agentSummary(cfg),
  };
}
