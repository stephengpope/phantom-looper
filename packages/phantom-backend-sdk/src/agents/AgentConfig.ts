// AgentConfig — what an agent of a type runs on, resolved from settings:
// provider, model, base URL, API key, reasoning, step limit. A session may
// pin a model; a type other than the first registered inherits the first's
// provider/model when its own are unset (the cascade). Stub.
import type { SettingScope } from '../storage/Settings.js';

export interface ModelPin { provider: string | null; model: string | null; baseUrl: string | null }
export interface ResolvedModel { provider: string; model: string; baseUrl: string | null; source: 'own' | 'inherited' | 'pinned' }
export interface AgentRunConfig {
  type: string; model: ResolvedModel; apiKey: string | undefined; reasoning: string | null; maxSteps: number | null;
}

export class AgentConfig {
  /** The whole config for a type in a scope, the session's pin applied. Throws `config_invalid` when no provider/model is set. */
  async resolve(type: string, scope: SettingScope, pin?: ModelPin | null): Promise<AgentRunConfig> { throw stub(); }
  /** Provider/model/baseUrl only — what a newborn session is pinned to. */
  async modelFor(type: string, scope: SettingScope): Promise<ModelPin> { throw stub(); }
  /** Every credential's stored value at the global and project layers, decrypted — the settings editor's view. */
  async credentialLayers(scope: SettingScope): Promise<Record<string, { global: string | null; project: string | null }>> { throw stub(); }
}
const stub = () => new Error('stub');
