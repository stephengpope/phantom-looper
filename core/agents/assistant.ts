// The Assistant. Its system prompt layout: its own document
// (core/prompts/assistant) and the date. Its session follows the one the
// user is looking at (`follow`): its file tools open that session's folder.
import { Agent, agentText, type AgentHandlers, type PhantomBackend, type SystemPromptLayout } from 'phantom-client-sdk';
import { systemPrompt as assistantInstructions } from '../prompts/assistant/wiring.js';

export class AssistantAgent extends Agent {
  readonly type = 'assistant';

  static readonly systemPromptLayout: SystemPromptLayout = {
    stable: [agentText(assistantInstructions())],
    context: [],
    volatile: ['time_date'],
  };

  static newSession(backend: PhantomBackend, handlers: AgentHandlers,
    opts: { workspaceId: string; activeSessionId?: string | null }): Promise<AssistantAgent> {
    return AssistantAgent.create(backend, handlers, (b) => b.call('POST', '/sessions/assistant',
      { workspace_id: opts.workspaceId, ...(opts.activeSessionId ? { session_id: opts.activeSessionId } : {}),
        system_prompt_layout: AssistantAgent.systemPromptLayout }));
  }

  /** Point the assistant's file tools at another session's folder. */
  follow(workspaceId: string, activeSessionId: string | null): Promise<unknown> {
    return this.backend.call('POST', `/sessions/${this.session.id}/follow`, { workspace_id: workspaceId, session_id: activeSessionId });
  }
}
