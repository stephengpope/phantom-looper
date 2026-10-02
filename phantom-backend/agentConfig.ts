// The OLD path's agent config (core/llm's AgentConfig shape) built from the
// backend SDK's AgentConfig. Goes with core/llm (plan §7): the card run,
// cron and Telegram still take the old shape — model + steps + compaction
// + timezone — and this app's rule that the SUPERVISOR's model writes every
// compaction summary lives here, not in the SDK.
import type { AgentConfig as OldAgentConfig, AgentName } from '../core/llm/agentConfig.js';
import type { ModelConfig, Provider, Reasoning } from '../core/llm/createAgent.js';
import type { AgentConfig, AgentRunConfig, ModelPin, SettingScope, Settings } from 'phantom-backend-sdk';

export { sessionPin, type ModelPin } from 'phantom-backend-sdk';
export type { OldAgentConfig as AgentConfig, AgentName };

const toModelConfig = (model: AgentRunConfig['model']): ModelConfig => ({
  provider: model.provider as Provider, model: model.model,
  baseUrl: model.baseUrl ?? undefined, apiKey: model.apiKey,
  reasoning: model.reasoning != null ? (model.reasoning as Reasoning) : undefined,
});

/** The old shape for `type`, in a scope, with the session's pin. */
export async function oldAgentConfig(
  agentConfig: AgentConfig, settings: Settings, type: string, scope: SettingScope, pin: ModelPin | null = null,
): Promise<OldAgentConfig> {
  const [run, compaction, supervisor, timezone] = await Promise.all([
    agentConfig.resolve(type, scope, pin),
    agentConfig.compactionFor(type, scope, pin),
    agentConfig.resolve('supervisor', scope),
    settings.resolve<string>('timezone', scope),
  ]);
  return {
    agent: type as AgentName, model: toModelConfig(run.model), maxSteps: run.maxSteps,
    compaction: { ...compaction, model: toModelConfig(supervisor.model) },
    timezone,
  };
}
