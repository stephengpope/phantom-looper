// The handle for the model a turn runs on. The config comes from the
// server with every turn start and is never kept; the handle is rebuilt
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

export class ModelHandle {
  #cached: { key: string; model: LanguageModel } | null = null;

  constructor(private readonly backend: BackendClient, private readonly type: string, private readonly sessionId: string,
    private readonly hooks: ModelHooks) {}

  /** The handle for this turn's config. */
  resolve(c: LlmConfig): ResolvedModel {
    if (!c.model?.provider || !c.model.model) throw new PhantomError('config_invalid', 'no model is set for this agent — pick one on /settings');
    const key = JSON.stringify(c.model);
    if (this.#cached?.key !== key) {
      this.#cached = { key, model: billedModel(this.backend, c.model, { type: this.type, sessionId: this.sessionId }, this.hooks) };
    }
    return { spec: c.model, maxSteps: c.maxSteps, model: this.#cached.model, reasoning: effectiveReasoning(c.model) };
  }
}
