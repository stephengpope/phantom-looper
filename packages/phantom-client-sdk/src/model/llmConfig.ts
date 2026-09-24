// The SHAPE of what an agent's model runs on. Frozen on the session row at
// creation (Agent.create) and read back on resume; where the values come
// from (the server's settings cascade, GET /agents/:kind/config) is not the
// SDK's business. The API key is NOT here: keys rotate, so it is read live
// for the frozen provider.
import { PhantomError } from '../errors.js';

export const PROVIDERS = ['anthropic', 'openai', 'openai-codex', 'google', 'deepseek', 'kimi', 'xai', 'mistral', 'groq', 'openai-compatible'] as const;
export type Provider = typeof PROVIDERS[number];
export const REASONINGS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type Reasoning = typeof REASONINGS[number];

export const isProvider = (s: unknown): s is Provider => typeof s === 'string' && (PROVIDERS as readonly string[]).includes(s);
export const isReasoning = (s: unknown): s is Reasoning => typeof s === 'string' && (REASONINGS as readonly string[]).includes(s);

export interface CompactionConfig {
  /** Compact when the last step's input tokens pass this percent of the window. */
  thresholdPct: number;
  /** The model's context window, in tokens. Null = unknown, never compacts automatically. */
  contextWindow: number | null;
  /** How much of the history (by message count, oldest first) the summary replaces. */
  summarizePct: number;
  /** Which summarizer writes it. */
  strategy: string;
  /** Cap on the summary's length. Null = the model's default. */
  maxTokens: number | null;
}

/** The model that WRITES a summary — the small-fast slot, never the
 *  agent's own. NOT frozen: read live at compaction time, so a chat born
 *  on last month's settings compacts with today's writer and today's key. */
export interface SummaryWriter { provider: Provider; model: string; endpoint: string | null; reasoning: Reasoning | null; apiKey: string | null }

export interface LlmConfig {
  provider: Provider;
  model: string;
  /** For providers that take one (openai-compatible must). */
  endpoint: string | null;
  reasoning: Reasoning | null;
  /** Tool-call rounds per turn. Null = unlimited: the turn ends when the
   *  model stops calling tools. */
  maxSteps: number | null;
  compaction: CompactionConfig;
}

/** The shape GET /agents/:kind/config answers with. */
export interface RawAgentConfig {
  model?: { provider?: string; model?: string; baseUrl?: string | null; reasoning?: string | null; apiKey?: string | null };
  maxSteps?: number | null;
  compaction?: {
    thresholdPct?: number; contextWindow?: number | null; summarizePct?: number; strategy?: string;
    maxTokens?: number | null;
    model?: { provider?: string; model?: string; baseUrl?: string | null; reasoning?: string | null; apiKey?: string | null };
  };
}

/** The frozen part of an agent config. Throws config_invalid on a shape the
 *  SDK cannot run. */
export function llmConfigFrom(raw: unknown): LlmConfig {
  const r = raw as RawAgentConfig | null;
  const m = r?.model;
  if (!m || !isProvider(m.provider) || !m.model) {
    throw new PhantomError('config_invalid', 'agent config has no provider/model — pick one on /settings');
  }
  const c = r.compaction ?? {};
  return {
    provider: m.provider, model: m.model, endpoint: m.baseUrl ?? null,
    reasoning: isReasoning(m.reasoning) ? m.reasoning : null,
    maxSteps: r.maxSteps != null && r.maxSteps > 0 ? r.maxSteps : null,
    compaction: {
      thresholdPct: c.thresholdPct ?? 80,
      contextWindow: c.contextWindow ?? null,
      summarizePct: c.summarizePct ?? 50,
      strategy: c.strategy ?? 'fast',
      maxTokens: c.maxTokens ?? null,
    },
  };
}

/** The live summary writer from the same answer: the compaction model when
 *  the settings name one, else the agent's own — with its key. */
export function summaryWriterFrom(raw: unknown): SummaryWriter {
  const r = raw as RawAgentConfig | null;
  const cm = r?.compaction?.model ?? r?.model;
  if (!cm || !isProvider(cm.provider) || !cm.model) {
    throw new PhantomError('config_invalid', 'no model to write the summary with — pick one on /settings');
  }
  return { provider: cm.provider, model: cm.model, endpoint: cm.baseUrl ?? null,
    reasoning: isReasoning(cm.reasoning) ? cm.reasoning : null, apiKey: cm.apiKey ?? null };
}
