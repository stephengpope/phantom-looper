// Config → agent, once, for every caller: the cli's screens
// and the server's looper read the same settings rows, and this is the one
// resolver that turns them into a ModelConfig and a coding agent. The cli's
// agentFromConfig delegates here; the looper calls it directly.
import type { Tool } from 'ai';
import { NO_PROVIDER, type Agent, type ModelConfig, type Provider, type Reasoning } from './createAgent.js';
import { codingAgent } from './agents/coding.js';

/** One API key per provider, named the way each vendor names it — the same
 *  rows the Git Fixer and the Assistant read. */
export const PROVIDER_KEY = {
  anthropic: 'anthropic_api_key', openai: 'openai_api_key',
  google: 'google_api_key', 'openai-compatible': 'openai_compatible_api_key',
} as const;

export type SettingsValues = Record<string, unknown>;

/** null and '' both mean "not set" — the store never stores null, and the
 *  existing model overrides already treated '' as unset. */
const set = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

/** The cascade: a non-coding agent's provider/model/base_url from its three
 *  optional `<prefix>_*` settings, falling back to the coding agent's PER THE
 *  COMPATIBILITY RULE — a field inherits only while the resolved provider IS
 *  the coding provider. Overriding to a different provider makes the model
 *  required (a claude id on a google config is garbage) and stops base_url
 *  inheriting (an endpoint only means something for its own provider).
 *  Enforced HERE, at build time, never at write time: the settings store
 *  writes and clears keys one at a time, so no single write can see the whole
 *  pair — the error surfaces where the agent was needed (a blocked card, a
 *  notice, an auto-push step). */
export function cascade(cfg: SettingsValues, prefix: string):
{ provider: string; model: string; baseUrl: string | null } {
  const coding = set(cfg.provider);
  const provider = set(cfg[`${prefix}_provider`]) ?? coding;
  if (!provider) throw new Error(NO_PROVIDER);
  const inherits = provider === coding;
  const model = set(cfg[`${prefix}_model`]) ?? (inherits ? set(cfg.model) : null);
  if (!model) {
    throw new Error(inherits
      ? `no model set for ${provider} — pick one on /model (phantom-cli), or PATCH /settings {model}`
      : `${prefix}_provider is ${provider} but ${prefix}_model is not set — ` +
        `a model from the coding agent's provider (${coding}) cannot carry over`);
  }
  return { provider, model, baseUrl: set(cfg[`${prefix}_base_url`]) ?? (inherits ? set(cfg.base_url) : null) };
}

/** A non-coding agent's ModelConfig from the same resolved settings values:
 *  the cascade above, plus the key row for whichever provider won and the
 *  shared reasoning. cfg is a full GET /settings read, so every provider's
 *  key is already in it. */
export function agentModelConfig(cfg: SettingsValues, prefix: string): ModelConfig {
  const c = cascade(cfg, prefix);
  const keyField = PROVIDER_KEY[c.provider as keyof typeof PROVIDER_KEY];
  return {
    provider: c.provider as Provider, model: c.model, baseUrl: c.baseUrl ?? undefined,
    apiKey: keyField ? set(cfg[keyField]) ?? undefined : undefined,
    reasoning: cfg.reasoning != null ? (String(cfg.reasoning) as Reasoning) : undefined,
  };
}

/** provider/model/base_url/reasoning + the provider's key → ModelConfig.
 *  `model` may be overridden (kept for the coding agent itself; the other
 *  agents resolve through agentModelConfig's cascade). */
export function modelConfigFrom(cfg: SettingsValues, modelOverride?: string | null): ModelConfig {
  // Unset stays '' here: languageModel builds a handle that fails with the
  // fix on its first call, so a session still opens on a bare server.
  const provider = (set(cfg.provider) ?? '') as Provider;
  const keyField = PROVIDER_KEY[provider as keyof typeof PROVIDER_KEY];
  return {
    provider,
    model: set(modelOverride) ?? set(cfg.model) ?? '',
    baseUrl: (cfg.base_url as string | null) ?? undefined,
    apiKey: keyField ? (cfg[keyField] as string | null) ?? undefined : undefined,
    reasoning: cfg.reasoning != null ? (String(cfg.reasoning) as Reasoning) : undefined,
  };
}

/** The coding agent from resolved settings. null/unset max_steps = unlimited
 *  (the turn ends when the agent is done); a positive number is a cap.
 *  `onRetry` receives each failed model attempt as it happens (withRetry). */
export function buildCodingAgent(
  cfg: SettingsValues, tools: Record<string, Tool>, instructions?: string,
  modelFetch?: typeof fetch, onRetry?: (note: string) => void,
): { agent: Agent; summary: { provider: string; model: string; reasoning: string; maxSteps: number | null } } {
  const model = modelConfigFrom(cfg);
  if (modelFetch) model.fetch = modelFetch;
  if (onRetry) model.onRetry = onRetry;
  const n = cfg.max_steps == null ? null : Number(cfg.max_steps);
  const maxSteps = n != null && Number.isFinite(n) && n > 0 ? n : null;
  return {
    agent: codingAgent(model, tools, { maxSteps, instructions }),
    summary: { provider: model.provider || 'unset', model: model.model || 'unset',
      reasoning: String(cfg.reasoning ?? ''), maxSteps },
  };
}
