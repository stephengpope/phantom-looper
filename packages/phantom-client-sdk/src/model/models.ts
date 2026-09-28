// Which model a turn runs on, and the handle for it. Never kept between
// turns: every turn asks the server (GET /agents/:type/config?session=) and
// the server applies its own rule. The handle is rebuilt only when the
// answer moved; every call through it is billed to the session.
import type { LanguageModel } from 'ai';
import type { PhantomBackend } from '../backend.js';
import type { PhantomError } from '../errors.js';
import { billedModel, effectiveReasoning, type ModelSpec } from './languageModel.js';
import { llmConfigFrom, type LlmConfig, type Reasoning } from './llmConfig.js';
import type { RetryPolicy } from './retry.js';

export interface ResolvedModel {
  config: LlmConfig;
  model: LanguageModel;
  /** The reasoning level actually sent. */
  reasoning: Reasoning | undefined;
}

export class Models {
  #cached: { key: string; model: LanguageModel } | null = null;

  constructor(private readonly backend: PhantomBackend, private readonly type: string, private readonly sessionId: string,
    private readonly hooks: { retry: RetryPolicy; notice: (text: string) => void; onBillingError: (e: PhantomError) => void }) {}

  /** The model for the next turn, as the server resolves it now. */
  async resolve(signal: AbortSignal): Promise<ResolvedModel> {
    const config = llmConfigFrom(await this.backend.call('GET',
      `/agents/${encodeURIComponent(this.type)}/config?session=${encodeURIComponent(this.sessionId)}`, undefined, { signal }));
    const spec: ModelSpec = { provider: config.provider, model: config.model, endpoint: config.endpoint, reasoning: config.reasoning, apiKey: config.apiKey };
    const key = JSON.stringify(spec);
    if (this.#cached?.key !== key) {
      this.#cached = { key, model: billedModel(this.backend, spec, { kind: this.type, sessionId: this.sessionId }, this.hooks) };
    }
    return { config, model: this.#cached.model, reasoning: effectiveReasoning(spec) };
  }
}
