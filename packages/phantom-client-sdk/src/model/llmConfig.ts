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

/** THE rule for which providers may be picked: those with a key stored,
 *  plus any that takes no key (openai-codex reads its own login). Read off
 *  the settings entries — each credential entry names its `meta.provider`
 *  and where its value comes from (`source`; 'default' = no key stored).
 *  The settings picker, the cron tools' enum and the backend's cron
 *  validation all call this, so a provider you cannot call is never a
 *  choice anywhere. */
export function keyedProviders(entries: Record<string, { source?: string; meta?: object }>): Provider[] {
  const keyEntry = (provider: string) => Object.values(entries).find((entry) => (entry.meta as { provider?: string } | undefined)?.provider === provider);
  return PROVIDERS.filter((provider) => { const entry = keyEntry(provider); return !entry || entry.source !== 'default'; });
}
