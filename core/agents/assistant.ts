// The Assistant. Its system prompt layout: its own document
// (core/prompts/assistant) and the date. Its session follows the one the
// user is looking at (`follow`): its file tools open that session's workspace.
import { Agent, agentText, type AgentHandlers, type BackendClient, type SystemPromptLayout } from 'phantom-client-sdk';
import { systemPrompt as assistantInstructions } from '../prompts/assistant/wiring.js';

export class AssistantAgent extends Agent {
  readonly type = 'assistant';

  static readonly systemPromptLayout: SystemPromptLayout = {
    stable: [agentText(assistantInstructions())],
    context: [],
    volatile: ['time_date'],
  };

  static newSession(backend: BackendClient, handlers: AgentHandlers,
    opts: { projectId: string; activeSessionId?: string | null; startedBy?: string }): Promise<AssistantAgent> {
    return AssistantAgent.create(backend, handlers, (b) => b.call('POST', '/sessions',
      { project_id: opts.projectId, type: 'assistant', workspace_session_id: opts.activeSessionId ?? null,
        system_prompt_layout: AssistantAgent.systemPromptLayout,
        ...(opts.startedBy ? { started_by: opts.startedBy } : {}) }));
  }

  /** Point the assistant's file tools at another session's workspace. */
  follow(projectId: string, activeSessionId: string | null): Promise<unknown> {
    return this.backend.call('PATCH', `/sessions/${this.session.id}`, { project_id: projectId, workspace_session_id: activeSessionId });
  }
}
