// The Assistant. Its system prompt layout: its own document
// (phantom-looper/prompts/assistant) and the date. Its session follows the one the
// user is looking at (`follow`): its file tools open that session's workspace.
import { Agent, agentText, type AgentHandlers, type BackendClient, type SystemPromptLayout } from '@phantom-agent-sdk/client';
import { systemPrompt as assistantInstructions } from '../prompts/assistant/wiring.js';

/** Where the assistant's session points: the project, and the session
 *  whose workspace its file tools read (null = nothing on screen yet). */
export interface AssistantTarget { projectId: string; activeSessionId?: string | null }

export class AssistantAgent extends Agent {
  readonly type = 'assistant';

  static readonly systemPromptLayout: SystemPromptLayout = {
    stable: [agentText(assistantInstructions())],
    context: [],
    volatile: ['time_date'],
  };

  static newSession(backend: BackendClient, handlers: AgentHandlers, target: AssistantTarget): Promise<AssistantAgent> {
    return AssistantAgent.create(backend, handlers, (connection) => connection.call('POST', '/sessions',
      { project_id: target.projectId, type: 'assistant', workspace_session_id: target.activeSessionId ?? null,
        system_prompt_layout: AssistantAgent.systemPromptLayout }));
  }

  /** This client's actor's newest assistant conversation, pointed at
   *  `target` — or a new one when there is none. The row is one
   *  conversation that follows the user across sessions and projects, so
   *  the newest row of that actor's is the one, whatever project it last
   *  pointed at; newest by creation, so `/new assistant` (newSession) is
   *  what the next launch comes back to. */
  static async open(backend: BackendClient, handlers: AgentHandlers, target: AssistantTarget): Promise<AssistantAgent> {
    const query = new URLSearchParams({ type: 'assistant', started_by: backend.actorName, order: 'created', limit: '1' });
    const { sessions } = await backend.call<{ sessions: Array<{ id: string }> }>('GET', `/sessions?${query}`);
    const newest = sessions[0];
    if (!newest) return AssistantAgent.newSession(backend, handlers, target);
    const agent = await AssistantAgent.resumeSession(backend, handlers, newest.id);
    await agent.follow(target.projectId, target.activeSessionId ?? null);
    return agent;
  }

  /** Point the assistant's file tools at another session's workspace. */
  follow(projectId: string, activeSessionId: string | null): Promise<unknown> {
    return this.backend.call('PATCH', `/sessions/${this.session.id}`, { project_id: projectId, workspace_session_id: activeSessionId });
  }
}
