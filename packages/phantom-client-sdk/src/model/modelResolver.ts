// Resolves the model a turn runs on. The config comes from the
// server with every turn start and is never kept; the model is rebuilt
// only when the config moved. Every call through it is billed to the
// session.
import type { LanguageModel } from 'ai';
import type { BackendClient } from '../backend.js';
import { PhantomError } from '../errors.js';
import { billedModel, effectiveReasoning, type ModelHooks } from './languageModel.js';
import type { LlmConfig, ModelSpec, Reasoning } from './llmConfig.js';

export interface ResolvedModel {
  spec: ModelSpec;
  maxSteps: number | null;
  model: LanguageModel;
  /** The reasoning level actually sent. */
  reasoning: Reasoning | undefined;
}

export class ModelResolver {
  #cached: { key: string; model: LanguageModel } | null = null;

  constructor(private readonly backend: BackendClient, private readonly type: string, private readonly sessionId: string,
    private readonly hooks: ModelHooks) {}

  /** The handle for this turn's config. */
  resolve(config: LlmConfig): ResolvedModel {
    if (!config.model?.provider || !config.model.model) throw new PhantomError('config_invalid', 'no model is set for this agent — pick one on /settings');
    const key = JSON.stringify(config.model);
    if (this.#cached?.key !== key) {
      this.#cached = { key, model: billedModel(this.backend, config.model, { type: this.type, sessionId: this.sessionId }, this.hooks) };
    }
    return { spec: config.model, maxSteps: config.maxSteps, model: this.#cached.model, reasoning: effectiveReasoning(config.model) };
  }
}
