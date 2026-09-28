// The Assistant, built on the SDK's Agent runtime. Its prompt
// (core/llm/prompts/assistant) is built at every turn with today's date, as
// before. Its session follows the one on screen (`follow`): its read-only
// file tools open that session's folder and are rebuilt when it moves.
//
// Kit here: the board, read-only workspace tools, the web, crons. What only
// a host has — the cli's session and screen tools, Telegram's approvals, the
// git tools with their "session on screen" target — the host adds with `use()`.
import {
  Agent, call, type AgentHandlers, type PhantomBackend, type SessionRow, type ToolKit,
  kanbanToolKit, readonlyWorkspaceToolKit, webToolKit, cronsToolKit,
} from 'phantom-client-sdk';
import { systemPrompt as assistantInstructions } from '../llm/prompts/assistant/wiring.js';
import { withCurrentDate } from '../llm/prompts/template.js';
import { clockFor } from './clock.js';

export class AssistantAgent extends Agent {
  readonly kind = 'assistant';

  static create(backend: PhantomBackend, handlers: AgentHandlers,
    opts: { workspaceId: string; activeSessionId?: string | null }): Promise<AssistantAgent> {
    return Agent.birth<AssistantAgent>(AssistantAgent, backend, handlers,
      () => call<SessionRow>(backend, 'POST', '/sessions/assistant',
        { workspace_id: opts.workspaceId, ...(opts.activeSessionId ? { session_id: opts.activeSessionId } : {}) }));
  }

  static resume(backend: PhantomBackend, handlers: AgentHandlers, sessionId: string): Promise<AssistantAgent> {
    return Agent.wake<AssistantAgent>(AssistantAgent, backend, handlers, sessionId);
  }

  /** Point the assistant's file tools at another session's folder. */
  async follow(workspaceId: string, activeSessionId: string | null): Promise<void> {
    const row = await call<SessionRow>(this.backend, 'POST', `/sessions/${this.sessionId}/follow`,
      { workspace_id: workspaceId, session_id: activeSessionId });
    this.updateRow(row);
  }

  protected async systemPrompt(): Promise<string[]> {
    return [withCurrentDate(assistantInstructions(), await clockFor(this.backend, this.workspaceId))];
  }

  protected toolKits(): ToolKit[] {
    return [kanbanToolKit, readonlyWorkspaceToolKit, webToolKit, cronsToolKit];
  }
}
