// AgentConfig — what an agent of a type runs on, resolved from settings:
// provider, model, endpoint, key, reasoning, step limit; and its compaction
// numbers. THE place the `<type>_*` setting names are interpreted.
//
// THE RULES, each written once:
//
// Cascade — a type other than the first registered gets its provider /
// model / endpoint from its own `<type>_*` rows, falling back to the first
// type's PER THE COMPATIBILITY RULE: a field inherits only while the
// resolved provider IS the first type's. Overriding to a different provider
// makes the model required (a claude id on a google config is garbage) and
// stops the endpoint inheriting. Reasoning and the compaction settings
// cascade field by field (null = the first type's). Steps per turn do not
// cascade: a cap is per type.
//
// The pin — a session runs on its ROW's model, whole or not at all:
// provider, model, endpoint together. The pin carries its endpoint; one
// from before the column inherits the resolved endpoint only while the
// provider matches. The key follows the pinned provider. A pin may carry
// `reasoning` (a cron's does) — it wins over the cascade's level.
import type { Settings, SettingScope } from '../storage/Settings.js';
import type { AgentTypes } from './AgentTypes.js';
import type { ModelCatalog } from './ModelCatalog.js';

/** What a session row pins: the model it was born on. A cron's pin adds the reasoning level its runs use. */
export interface ModelPin { provider?: string | null; model?: string | null; baseUrl?: string | null; reasoning?: string | null }
export interface ResolvedModel { provider: string; model: string; baseUrl: string | null }
export interface AgentRunConfig {
  type: string;
  model: ResolvedModel & { apiKey: string | undefined; reasoning: string | null };
  maxSteps: number | null;
}
/** The compaction numbers for a type, cascaded; `contextWindow` is the
 *  catalog's figure for the model running, else the `<type>_context_window`
 *  override, else the first type's, else null. */
export interface CompactionSettings {
  thresholdPct: number; contextWindow: number | null; summarizePct: number; strategy: string; maxTokens: number | null;
}

/** One type's ten rows, as stored (null = unset). */
interface TypeRows {
  provider: string | null; model: string | null; baseUrl: string | null;
  reasoning: string | null; maxSteps: number | null;
  contextWindow: number | null;
  compactThresholdPct: number | null; compactStrategy: string | null;
  compactSummarizePct: number | null; compactMaxTokens: number | null;
}

/** null and '' both mean "not set". */
const set = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const inherit = <T>(own: T | null, first: T | null): T | null => (own != null ? own : first);

/** The pin for one session — THE ROW, whole or not at all. A row with no
 *  model reads as null and the agent runs on the settings. */
export function sessionPin(row?: ModelPin | null): ModelPin | null {
  return set(row?.provider) && set(row?.model)
    ? { provider: row!.provider, model: row!.model, baseUrl: row!.baseUrl ?? null }
    : null;
}

export class AgentConfig {
  constructor(
    private readonly settings: Settings,
    private readonly agentTypes: AgentTypes,
    private readonly modelCatalog: ModelCatalog,
  ) {}

  /** The whole config for a type in a scope, the session's pin applied.
   *  Throws when a provider is set with no model that fits it. No provider
   *  anywhere resolves to '' — an agent still builds on a bare backend and
   *  its first call fails with the fix in the message. */
  async resolve(type: string, scope: SettingScope = {}, pin: ModelPin | null = null): Promise<AgentRunConfig> {
    this.agentTypes.require(type);
    const first = this.agentTypes.first();
    const [firstRows, own] = await this.rowsOf([first, type], scope) as [TypeRows, TypeRows];
    const resolved = pinned(cascade(type, first, firstRows, own), pin);
    const credentialKey = resolved.provider ? this.settings.credentialKeyForProvider(resolved.provider) : undefined;
    const apiKey = credentialKey ? await this.settings.credential(credentialKey, scope) : undefined;
    return {
      type,
      model: { ...resolved, apiKey, reasoning: set(pin?.reasoning) ?? inherit(set(own.reasoning), set(firstRows.reasoning)) },
      maxSteps: own.maxSteps != null && own.maxSteps > 0 ? own.maxSteps : null,
    };
  }

  /** The type the others fall back to — the first registered. */
  firstType(): string { return this.agentTypes.first(); }

  /** Provider/model/endpoint from the settings alone (no pin) — what a newborn session is pinned to. */
  async modelFor(type: string, scope: SettingScope = {}): Promise<ResolvedModel> {
    const first = this.agentTypes.first();
    const [firstRows, own] = await this.rowsOf([first, type], scope) as [TypeRows, TypeRows];
    return cascade(type, first, firstRows, own);
  }

  /** The compaction numbers for a type, for the model it runs (pinned or resolved). */
  async compactionFor(type: string, scope: SettingScope = {}, pin: ModelPin | null = null): Promise<CompactionSettings> {
    const first = this.agentTypes.first();
    const [firstRows, own] = await this.rowsOf([first, type], scope) as [TypeRows, TypeRows];
    const resolved = pinned(cascade(type, first, firstRows, own), pin);
    const catalog = resolved.provider && resolved.model ? this.modelCatalog.contextWindowOf(resolved.provider, resolved.model) : 0;
    const required = <T>(value: T | null, name: string): T => {
      if (value == null) throw new Error(`settings default for ${first}_${name} is null — the first agent type's compaction settings must declare one`);
      return value;
    };
    return {
      thresholdPct: required(inherit(own.compactThresholdPct, firstRows.compactThresholdPct), 'compact_threshold_pct'),
      contextWindow: catalog > 0 ? catalog : inherit(own.contextWindow, firstRows.contextWindow),
      summarizePct: required(inherit(own.compactSummarizePct, firstRows.compactSummarizePct), 'compact_summarize_pct'),
      strategy: required(inherit(set(own.compactStrategy), set(firstRows.compactStrategy)), 'compact_strategy'),
      maxTokens: inherit(own.compactMaxTokens, firstRows.compactMaxTokens),
    };
  }

  /** Each type's ten rows, typed — one query for all of them. */
  private async rowsOf(types: readonly string[], scope: SettingScope): Promise<TypeRows[]> {
    const keys = types.flatMap((type) => [
      `${type}_provider`, `${type}_model`, `${type}_base_url`, `${type}_reasoning`, `${type}_max_steps`,
      `${type}_context_window`, `${type}_compact_threshold_pct`, `${type}_compact_strategy`,
      `${type}_compact_summarize_pct`, `${type}_compact_max_tokens`,
    ]);
    const values = await this.settings.resolveMany(keys, scope);
    const str = (key: string) => (typeof values[key] === 'string' ? values[key] as string : null);
    const num = (key: string) => (typeof values[key] === 'number' ? values[key] as number : null);
    return types.map((type) => ({
      provider: str(`${type}_provider`), model: str(`${type}_model`), baseUrl: str(`${type}_base_url`),
      reasoning: str(`${type}_reasoning`), maxSteps: num(`${type}_max_steps`),
      contextWindow: num(`${type}_context_window`),
      compactThresholdPct: num(`${type}_compact_threshold_pct`), compactStrategy: str(`${type}_compact_strategy`),
      compactSummarizePct: num(`${type}_compact_summarize_pct`), compactMaxTokens: num(`${type}_compact_max_tokens`),
    }));
  }
}

/** The cascade. Throws on a half-set pair (a provider override with no model) — the error names the fix. */
export function cascade(type: string, firstType: string, first: TypeRows, own: TypeRows): ResolvedModel {
  const firstProvider = set(first.provider);
  const provider = set(own.provider) ?? firstProvider;
  if (!provider) return { provider: '', model: '', baseUrl: null };
  const inherits = provider === firstProvider;
  const model = set(own.model) ?? (inherits ? set(first.model) : null);
  if (!model) {
    throw new Error(inherits
      ? `no model set for ${provider} — pick one on /settings, or on the project if it sets its own provider`
      : `${type}_provider is ${provider} but ${type}_model is not set — a model from the ${firstType} agent's provider (${firstProvider}) cannot carry over`);
  }
  return { provider, model, baseUrl: set(own.baseUrl) ?? (inherits ? set(first.baseUrl) : null) };
}

/** The pin laid over the cascade's answer. */
export function pinned(base: ResolvedModel, pin: ModelPin | null): ResolvedModel {
  const provider = set(pin?.provider);
  const model = set(pin?.model);
  if (!provider || !model) return base;
  return { provider, model, baseUrl: set(pin?.baseUrl) ?? (provider === base.provider ? base.baseUrl : null) };
}
