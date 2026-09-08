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
  google: 'google_api_key', deepseek: 'deepseek_api_key',
  kimi: 'kimi_api_key', xai: 'xai_api_key', mistral: 'mistral_api_key',
  groq: 'groq_api_key', 'openai-compatible': 'openai_compatible_api_key',
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
 *  the cascade above, plus the key row for whichever provider won, and
 *  reasoning (per-agent or the coding agent's). cfg is a full GET /settings
 *  read, so every provider's key is already in it. */
export function agentModelConfig(cfg: SettingsValues, prefix: string): ModelConfig {
  const c = cascade(cfg, prefix);
  const keyField = PROVIDER_KEY[c.provider as keyof typeof PROVIDER_KEY];
  // Reasoning cascades: per-agent override → coding agent's.
  const reasoning = set(cfg[`${prefix}_reasoning`]) ?? (cfg.reasoning != null ? String(cfg.reasoning) : undefined);
  return {
    provider: c.provider as Provider, model: c.model, baseUrl: c.baseUrl ?? undefined,
    apiKey: keyField ? set(cfg[keyField]) ?? undefined : undefined,
    reasoning: reasoning != null ? (reasoning as Reasoning) : undefined,
  };
}

/** A non-coding agent's max_steps from its `<prefix>_max_steps` setting,
 *  defaulting to unlimited (null). */
export function agentMaxSteps(cfg: SettingsValues, prefix: string): number | null {
  const n = cfg[`${prefix}_max_steps`] == null ? null : Number(cfg[`${prefix}_max_steps`]);
  return n != null && Number.isFinite(n) && n > 0 ? n : null;
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

// --- the session's pin -------------------------------------------------------
// One rule, one place, for every caller that runs a coding turn: a session that
// has said anything runs on the model it already ran on. Global settings reach
// a session with nothing said yet, and nothing else. The pin is written once
// (the transcript save route, from the first header) and never moves, so
// changing /model can no longer reach a conversation in progress — not from the
// app, not from the looper, not from Telegram, not from a plan-mode flip.

/** What a session is pinned to: the row's columns, or — for rows written
 *  before the columns existed — its transcript header. */
export interface ModelPin { provider?: string | null; model?: string | null; baseUrl?: string | null }

/** The pin for one session. The row wins whole; a row missing the pair falls
 *  back to the header whole. Never mixed field by field: a provider from one
 *  source and an endpoint from the other is exactly the split this prevents. */
export function sessionPin(
  row?: { provider?: string | null; model?: string | null; baseUrl?: string | null } | null,
  header?: { provider?: unknown; model?: unknown; base_url?: unknown } | null,
): ModelPin | null {
  if (set(row?.provider) && set(row?.model)) {
    return { provider: row!.provider, model: row!.model, baseUrl: row!.baseUrl ?? null };
  }
  const hp = typeof header?.provider === 'string' ? header.provider : null;
  const hm = typeof header?.model === 'string' ? header.model : null;
  if (set(hp) && set(hm)) {
    return { provider: hp, model: hm,
      baseUrl: typeof header?.base_url === 'string' ? header.base_url : null };
  }
  return null;
}

/** The settings a session's turn builds from: the resolved global values with
 *  the session's pin laid over them, as a COPY (the caller's values still feed
 *  the other agents' cascade). No pin — a session with nothing said yet —
 *  returns them untouched.
 *
 *  The endpoint rides the pin, because a provider and a model name do not say
 *  where to send the request: a session pinned to one provider must not inherit
 *  an endpoint someone set for another. A pin carrying no endpoint (an old
 *  header) inherits the global one only while the provider matches — the same
 *  compatibility rule as `cascade`. */
/** The same rule for an agent whose model comes from the cascade (the
 *  supervisor's `supervisor_*` trio): its resolved config, with the session's
 *  pin — provider, model, endpoint and that provider's key — laid over it.
 *  Reasoning and max_steps are settings, not part of what ran, so they keep
 *  following the cascade. */
export function pinnedModel(base: ModelConfig, cfg: SettingsValues, pin?: ModelPin | null): ModelConfig {
  const provider = set(pin?.provider);
  const model = set(pin?.model);
  if (!provider || !model) return base;
  const keyField = PROVIDER_KEY[provider as keyof typeof PROVIDER_KEY];
  return { ...base, provider: provider as Provider, model,
    baseUrl: set(pin?.baseUrl) ?? (provider === base.provider ? base.baseUrl ?? null : null) ?? undefined,
    apiKey: keyField ? set(cfg[keyField]) ?? undefined : undefined };
}

export function pinnedCfg<T extends SettingsValues>(cfg: T, pin?: ModelPin | null): T {
  const provider = set(pin?.provider);
  const model = set(pin?.model);
  if (!provider || !model) return cfg;
  return { ...cfg, provider, model,
    base_url: set(pin?.baseUrl) ?? (provider === set(cfg.provider) ? set(cfg.base_url) : null) };
}
