// One-shot model calls this app makes for itself — a commit message, a
// session title, the digest — on the client SDK's billed model: the type's
// resolved config from the backend, every call logged to log_tokens under
// the work's type (commit_message, title, session_digest). No agent, no
// session turn: one prompt in, text out.
import { generateText } from 'ai';
import { billedModel, BackendClient, type ModelSpec } from '@phantom-agent-sdk/client';
import type { AgentConfig, SettingScope, ModelPin } from '@phantom-agent-sdk/backend';
import { logger } from '@phantom-agent-sdk/backend';

const log = logger('one-shot');

export interface OneShotDeps { agentConfig: AgentConfig; client: BackendClient }

/** One call on `type`'s model (the assistant's for every helper today).
 *  Throws when the type cannot build (no provider / a half-set pair) — the
 *  caller decides what a missing answer means. `report` hears each retry. */
export async function oneShot(
  deps: OneShotDeps, type: string, work: { type: string; sessionId: string | null },
  request: { system?: string; prompt: string; maxOutputTokens?: number | null },
  options: { scope?: SettingScope; pin?: ModelPin | null; report?: (note: string) => void } = {},
): Promise<string> {
  const config = await deps.agentConfig.resolve(type, options.scope ?? {}, options.pin ?? null);
  if (!config.model.provider || !config.model.model) throw new Error(`no model set for ${type} — pick one on /settings`);
  const spec: ModelSpec = { provider: config.model.provider as ModelSpec['provider'], model: config.model.model,
    baseUrl: config.model.baseUrl, reasoning: (config.model.reasoning ?? null) as ModelSpec['reasoning'], apiKey: config.model.apiKey ?? null };
  const model = billedModel(deps.client, spec, work, {
    notice: (text) => { log.warn({ work: work.type }, text); options.report?.(text); },
    onBillingError: (error) => log.warn({ work: work.type, err: error.message }, 'billing failed'),
  });
  const { text } = await generateText({
    model, maxRetries: 0,
    ...(request.system ? { system: request.system } : {}),
    prompt: request.prompt,
    ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
  });
  return text;
}
