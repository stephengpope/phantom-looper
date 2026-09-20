// How settings become an agent's runtime configuration — THE one place the
// three agents' setting names are interpreted. Settings.agentConfig() is the
// door; this file is its arithmetic, on typed rows it is handed, never on a
// loose map. Nothing outside the settings domain reads `coding_provider` or
// `assistant_compact_threshold_pct` by name again: the looper, Telegram, the
// digest, the titler, the commit message, the turn route and (over
// GET /agents/:agent/config) the cli all take the finished AgentConfig.
//
// THE RULES, each written once:
//
// Cascade — a non-coding agent's provider/model/endpoint come from its own
// `<agent>_*` rows, falling back to the coding agent's, PER THE COMPATIBILITY
// RULE: a field inherits only while the resolved provider IS the coding
// provider. Overriding to a different provider makes the model required (a
// claude id on a google config is garbage) and stops the endpoint inheriting
// (an endpoint only means something for its own provider). Reasoning and the
// compaction settings cascade field by field (null = the coding agent's).
// Steps per turn do not cascade: a cap is per agent.
//
// The pin — a session runs on its ROW's model, whole or not at all: provider,
// model, endpoint together (sessions.ts owns when the row may move). The pin
// carries its endpoint; one from before the column inherits the resolved
// endpoint only while the provider matches. The key follows the pinned
// provider.
//
// Compaction — thresholds and strategy are the agent's own (cascading); the
// context window is the catalog's figure for the model actually running
// (pinned or resolved), else the agent's `<agent>_context_window` override,
// else the coding agent's, else unknown. The summary is always written by
// the SUPERVISOR's model — the small-fast slot — never by the agent itself.
import type { ModelConfig, Provider, Reasoning } from '../core/llm/createAgent.js';
import type { AgentConfig, AgentName } from '../core/llm/agentConfig.js';
import type { CompactionConfig } from '../core/llm/compaction.js';
import { contextWindowFor } from './models.js';

export type { AgentConfig, AgentName };

/** One agent's own rows, as stored (null = unset). Settings maps the ten
 *  `<agent>_*` keys into this once, so setting names appear in exactly one
 *  function (Settings.agentRows). */
export interface AgentRows {
  provider: string | null; model: string | null; baseUrl: string | null;
  reasoning: string | null; maxSteps: number | null;
  contextWindow: number | null;
  compactThresholdPct: number | null; compactStrategy: string | null;
  compactSummarizePct: number | null; compactMaxTokens: number | null;
}

/** What a session row pins: the model it was born on. */
export interface ModelPin { provider?: string | null; model?: string | null; baseUrl?: string | null }

/** null and '' both mean "not set" — the store never stores null, and the
 *  model overrides always treated '' as unset. */
const set = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The pin for one session — THE ROW, whole or not at all. A row with no
 *  model (born before the column, or on a server with no provider set) reads
 *  as null and the agent runs on the settings. */
export function sessionPin(row?: ModelPin | null): ModelPin | null {
  return set(row?.provider) && set(row?.model)
    ? { provider: row!.provider, model: row!.model, baseUrl: row!.baseUrl ?? null }
    : null;
}

export interface ResolvedModel { provider: string; model: string; baseUrl: string | null }

/** The cascade. Throws on a half-set pair (a provider override with no
 *  model) — the error names the fix. No provider anywhere resolves to '',
 *  not an error: an agent still BUILDS on a bare server (a session opens,
 *  the banner draws) and its first call fails with the fix in the message
 *  (languageModel's unsetModel). */
export function cascade(agent: AgentName, coding: AgentRows, own: AgentRows): ResolvedModel {
  const codingProvider = set(coding.provider);
  const provider = set(own.provider) ?? codingProvider;
  if (!provider) return { provider: '', model: '', baseUrl: null };
  const inherits = provider === codingProvider;
  const model = set(own.model) ?? (inherits ? set(coding.model) : null);
  if (!model) {
    throw new Error(inherits
      ? `no model set for ${provider} — pick one on /settings, or on the workspace if it sets its own provider (phantom-cli)`
      : `${agent}_provider is ${provider} but ${agent}_model is not set — ` +
        `a model from the coding agent's provider (${codingProvider}) cannot carry over`);
  }
  return { provider, model, baseUrl: set(own.baseUrl) ?? (inherits ? set(coding.baseUrl) : null) };
}

/** The pin laid over the cascade's answer. */
export function pinned(base: ResolvedModel, pin: ModelPin | null): ResolvedModel {
  const provider = set(pin?.provider);
  const model = set(pin?.model);
  if (!provider || !model) return base;
  return { provider, model, baseUrl: set(pin?.baseUrl) ?? (provider === base.provider ? base.baseUrl : null) };
}

/** The per-field cascade for everything that is not the model trio. */
const inherit = <T>(own: T | null, coding: T | null): T | null => (own != null ? own : coding);

/** A field the coding agent's DEFAULTS never leave null (threshold,
 *  summarize %, strategy). No default is repeated here: if the row is null
 *  the declaration in settings.ts changed, and that is the bug to see. */
function required<T>(v: T | null, name: string): T {
  if (v == null) throw new Error(`settings default for coding_${name} is null — settings.ts DEFAULTS must declare one`);
  return v;
}

export interface AgentConfigInput {
  agent: AgentName;
  coding: AgentRows;
  own: AgentRows;
  supervisor: AgentRows;
  pin: ModelPin | null;
  /** The decrypted key for the provider `model` resolved to, and for the
   *  supervisor's. Settings reads them after cascade+pin decide the provider. */
  keys: { agent: string | undefined; supervisor: string | undefined };
  /** The `timezone` setting at the same scope. */
  timezone: string;
}

/** The model trio + pin for `agent` — what Settings needs BEFORE it can read
 *  the right key. */
export function resolveModel(agent: AgentName, coding: AgentRows, own: AgentRows, pin: ModelPin | null): ResolvedModel {
  return pinned(cascade(agent, coding, own), pin);
}

function modelConfig(r: ResolvedModel, reasoning: string | null, apiKey: string | undefined): ModelConfig {
  return {
    provider: r.provider as Provider, model: r.model,
    baseUrl: r.baseUrl ?? undefined, apiKey,
    reasoning: reasoning != null ? (reasoning as Reasoning) : undefined,
  };
}

/** The whole answer, given the rows and the two keys. */
export function agentConfigFrom(i: AgentConfigInput): AgentConfig {
  const { agent, coding, own, supervisor, pin } = i;
  const resolved = resolveModel(agent, coding, own, pin);
  const model = modelConfig(resolved, inherit(set(own.reasoning), set(coding.reasoning)), i.keys.agent);

  // The supervisor's model writes every summary. Unpinned: it is whatever
  // the settings say now, not what some conversation was born on.
  const supervisorModel = modelConfig(cascade('supervisor', coding, supervisor),
    inherit(set(supervisor.reasoning), set(coding.reasoning)), i.keys.supervisor);

  const catalog = resolved.provider && resolved.model ? contextWindowFor(resolved.provider, resolved.model) : 0;
  const compaction: CompactionConfig = {
    thresholdPct: required(inherit(own.compactThresholdPct, coding.compactThresholdPct), 'compact_threshold_pct'),
    contextWindow: catalog > 0 ? catalog : inherit(own.contextWindow, coding.contextWindow),
    summarizePct: required(inherit(own.compactSummarizePct, coding.compactSummarizePct), 'compact_summarize_pct'),
    strategy: required(inherit(set(own.compactStrategy), set(coding.compactStrategy)), 'compact_strategy'),
    maxTokens: inherit(own.compactMaxTokens, coding.compactMaxTokens),
    model: supervisorModel,
  };

  return { agent, model, maxSteps: own.maxSteps != null && own.maxSteps > 0 ? own.maxSteps : null, compaction, timezone: i.timezone };
}
