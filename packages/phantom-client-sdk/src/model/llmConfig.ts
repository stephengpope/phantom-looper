// What an agent's model runs on — GET /agents/:type/config?session=, as the
// server answers it. Read at the start of every turn and never kept: which
// model a session runs on is the server's rule, applied there; the key rides
// the same answer.
export const PROVIDERS = ['anthropic', 'openai', 'openai-codex', 'google', 'deepseek', 'kimi', 'xai', 'mistral', 'groq', 'openai-compatible'] as const;
export type Provider = typeof PROVIDERS[number];
export const REASONINGS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type Reasoning = typeof REASONINGS[number];

export interface ModelSpec {
  provider: Provider;
  model: string;
  /** For providers that take one (openai-compatible must). */
  baseUrl: string | null;
  reasoning: Reasoning | null;
  /** The live key for `provider`; null for one that needs none. */
  apiKey: string | null;
}

export interface LlmConfig {
  model: ModelSpec;
  /** Tool-call rounds per turn. Null = unlimited: the turn ends when the
   *  model stops calling tools. */
  maxSteps: number | null;
}
