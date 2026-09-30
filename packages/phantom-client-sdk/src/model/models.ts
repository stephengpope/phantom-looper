// Which model a turn runs on, and the handle for it. Never kept between
// turns: every turn asks the server (GET /agents/:type/config?session=) and
// the server applies its own rule. The handle is rebuilt only when the
// answer moved; every call through it is billed to the session.
import type { LanguageModel } from 'ai';
import type { PhantomBackend } from '../backend.js';
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

export class Models {
  #cached: { key: string; model: LanguageModel } | null = null;

  constructor(private readonly backend: PhantomBackend, private readonly type: string, private readonly sessionId: string,
    private readonly hooks: ModelHooks) {}

  /** The model for the next turn, as the server resolves it now. */
  async resolve(signal: AbortSignal): Promise<ResolvedModel> {
    const c = await this.backend.call<LlmConfig>('GET',
      `/agents/${encodeURIComponent(this.type)}/config?session=${encodeURIComponent(this.sessionId)}`, undefined, { signal });
    if (!c.model?.provider || !c.model.model) throw new PhantomError('config_invalid', 'no model is set for this agent — pick one on /settings');
    const key = JSON.stringify(c.model);
    if (this.#cached?.key !== key) {
      this.#cached = { key, model: billedModel(this.backend, c.model, { type: this.type, sessionId: this.sessionId }, this.hooks) };
    }
    return { spec: c.model, maxSteps: c.maxSteps, model: this.#cached.model, reasoning: effectiveReasoning(c.model) };
  }
}
