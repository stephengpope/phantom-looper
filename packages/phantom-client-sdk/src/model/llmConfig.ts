// The SHAPE of what an agent's model runs on. Read from the server at the
// start of every turn (GET /agents/:kind/config?session=) and never kept:
// which model a session runs on is the server's rule, applied there. The
// keys ride the same answer and are read apart (keysFrom), for the one use.
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
  /** The model that WRITES the summary — never the agent's own. */
  model: { provider: Provider; model: string; endpoint: string | null; reasoning: Reasoning | null };
}

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

/** What GET /agents/:kind/config answers, mapped to the shape a turn runs
 *  on. Throws config_invalid on a shape the SDK cannot run. */
export function llmConfigFrom(raw: unknown): LlmConfig {
  const r = raw as {
    model?: { provider?: string; model?: string; baseUrl?: string | null; reasoning?: string | null };
    maxSteps?: number | null;
    compaction?: {
      thresholdPct?: number; contextWindow?: number | null; summarizePct?: number; strategy?: string;
      maxTokens?: number | null;
      model?: { provider?: string; model?: string; baseUrl?: string | null; reasoning?: string | null };
    };
  } | null;
  const m = r?.model;
  if (!m || !isProvider(m.provider) || !m.model) {
    throw new PhantomError('config_invalid', 'agent config has no provider/model — pick one on /settings');
  }
  const c = r.compaction ?? {};
  const cm = c.model ?? m;
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
      model: {
        provider: isProvider(cm.provider) ? cm.provider : m.provider,
        model: cm.model ?? m.model,
        endpoint: cm.baseUrl ?? null,
        reasoning: isReasoning(cm.reasoning) ? cm.reasoning : null,
      },
    },
  };
}

/** The keys in the same answer: the agent's model's, and the summary
 *  model's — each for its own provider, as the server resolved them. */
export interface AgentKeys { model: string | null; compaction: string | null }

export function keysFrom(raw: unknown): AgentKeys {
  const r = raw as { model?: { apiKey?: string | null }; compaction?: { model?: { apiKey?: string | null } } } | null;
  return { model: r?.model?.apiKey ?? null, compaction: r?.compaction?.model?.apiKey ?? null };
}
