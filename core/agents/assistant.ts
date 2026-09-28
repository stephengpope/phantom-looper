// The Assistant. Prompt: core/llm/prompts/assistant, built every turn with
// today's date. Its session follows the one the user is looking at
// (`follow`): its file tools open that session's folder.
import { Agent, type AgentHandlers, type PhantomBackend } from 'phantom-client-sdk';
import { systemPrompt as assistantInstructions } from '../llm/prompts/assistant/wiring.js';
import { withCurrentDate } from '../llm/prompts/template.js';
import { clockFor } from './clock.js';

export class AssistantAgent extends Agent {
  readonly type = 'assistant';

  static start(backend: PhantomBackend, handlers: AgentHandlers,
    opts: { workspaceId: string; activeSessionId?: string | null }): Promise<AssistantAgent> {
    return AssistantAgent.create(backend, handlers, (b) => b.call('POST', '/sessions/assistant',
      { workspace_id: opts.workspaceId, ...(opts.activeSessionId ? { session_id: opts.activeSessionId } : {}) }));
  }

  /** Point the assistant's file tools at another session's folder. The row
   *  is re-read at the next turn. */
  follow(workspaceId: string, activeSessionId: string | null): Promise<unknown> {
    return this.backend.call('POST', `/sessions/${this.session.id}/follow`, { workspace_id: workspaceId, session_id: activeSessionId });
  }

  protected async systemPrompt(): Promise<string[]> {
    return [withCurrentDate(assistantInstructions(), await clockFor(this.backend, this.session.workspaceId))];
  }
}
