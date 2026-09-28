// The supervisor — the judge in a card run — built on the SDK's Agent
// runtime. Its prompt (core/llm/prompts/supervisor) is built at every turn
// with today's date, as before. Its session is conversation-only, on the
// coder's folder, so its read-only file tools open the coder's checkout.
//
// Kit: read-only inspection, the card read, the web. The run's board powers
// (kanban_card_move, kanban_card_items bound to THE card) are the loop's own
// and are added by it with `use()` — nothing about the loop lives here.
import {
  Agent, call, type AgentHandlers, type PhantomBackend, type SessionRow, type ToolKit,
  readonlyWorkspaceToolKit, kanbanReadToolKit, webToolKit,
} from 'phantom-client-sdk';
import { systemPrompt as supervisorInstructions } from '../llm/prompts/supervisor/wiring.js';
import { withCurrentDate } from '../llm/prompts/template.js';
import { clockFor } from './clock.js';

export class SupervisorAgent extends Agent {
  readonly kind = 'supervisor';

  static create(backend: PhantomBackend, handlers: AgentHandlers,
    opts: { workspaceId: string; folderId: string; cardId: number }): Promise<SupervisorAgent> {
    return Agent.birth<SupervisorAgent>(SupervisorAgent, backend, handlers,
      () => call<SessionRow>(backend, 'POST', '/sessions/supervisor',
        { workspace_id: opts.workspaceId, folder_id: opts.folderId, card_id: opts.cardId }));
  }

  static resume(backend: PhantomBackend, handlers: AgentHandlers, sessionId: string): Promise<SupervisorAgent> {
    return Agent.wake<SupervisorAgent>(SupervisorAgent, backend, handlers, sessionId);
  }

  protected async systemPrompt(): Promise<string[]> {
    return [withCurrentDate(supervisorInstructions(), await clockFor(this.backend, this.workspaceId))];
  }

  protected toolKits(): ToolKit[] {
    return [readonlyWorkspaceToolKit, kanbanReadToolKit, webToolKit];
  }
}
