// The SHAPE of what an agent's model runs on. Read from the server at the
// start of every turn (GET /agents/:type/config?session=) and never kept:
// which model a session runs on is the server's rule, applied there. The
// key rides the same answer.
import { PhantomError } from '../errors.js';

export const PROVIDERS = ['anthropic', 'openai', 'openai-codex', 'google', 'deepseek', 'kimi', 'xai', 'mistral', 'groq', 'openai-compatible'] as const;
export type Provider = typeof PROVIDERS[number];
export const REASONINGS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type Reasoning = typeof REASONINGS[number];

export const isProvider = (s: unknown): s is Provider => typeof s === 'string' && (PROVIDERS as readonly string[]).includes(s);
export const isReasoning = (s: unknown): s is Reasoning => typeof s === 'string' && (REASONINGS as readonly string[]).includes(s);

export interface LlmConfig {
  provider: Provider;
  model: string;
  /** For providers that take one (openai-compatible must). */
  endpoint: string | null;
  reasoning: Reasoning | null;
  /** The live key for `provider`; null for one that needs none. */
  apiKey: string | null;
  /** Tool-call rounds per turn. Null = unlimited: the turn ends when the
   *  model stops calling tools. */
  maxSteps: number | null;
}

/** What GET /agents/:type/config answers, mapped to the shape a turn runs
 *  on. Throws config_invalid on a shape the SDK cannot run. */
export function llmConfigFrom(raw: unknown): LlmConfig {
  const r = raw as {
    model?: { provider?: string; model?: string; baseUrl?: string | null; reasoning?: string | null; apiKey?: string | null };
    maxSteps?: number | null;
  } | null;
  const m = r?.model;
  if (!m || !isProvider(m.provider) || !m.model) {
    throw new PhantomError('config_invalid', 'agent config has no provider/model — pick one on /settings');
  }
  return {
    provider: m.provider, model: m.model, endpoint: m.baseUrl ?? null,
    reasoning: isReasoning(m.reasoning) ? m.reasoning : null,
    apiKey: m.apiKey ?? null,
    maxSteps: r.maxSteps != null && r.maxSteps > 0 ? r.maxSteps : null,
  };
}
