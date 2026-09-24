// The supervisor — the looper's judge. One free-form turn per round, in a
// direct conversation with the coding agent: read-only inspection tools on
// the coder's checkout, the card read, the web, and — added by the looper
// per round with `use(loopSupervisorToolKit(card, column))` — its two board
// powers bound to THE card. The verdict IS the tool call.
//
// Its session is conversation-only: the row's folder is the coder's, so
// its file tools read the coder's checkout. The loop-authored messages
// (kickoffs, briefings) are exported from ./messages.js for the looper.
import { Agent, type AgentHandlers, type SessionRow } from '../../agent.js';
import { call, type PhantomBackend } from '../../backend.js';
import type { ToolKit } from '../../toolkit.js';
import { fill } from '../../prompts/template.js';
import { todayFor } from '../../prompts/date.js';
import { STAKEHOLDERS } from '../../prompts/stakeholders.js';
import { VALUES } from '../../prompts/values.js';
import { COMMUNICATION } from '../../prompts/communication.js';
import { SYSTEM } from './prompt.js';
import { readonlyWorkspaceToolKit } from '../../kits/workspace.js';
import { webToolKit } from '../../kits/web.js';
import { kanbanReadToolKit } from '../../kits/kanban.js';

export * from './messages.js';

export function supervisorPromptBlocks(date: string): string[] {
  return [`${fill(SYSTEM, { stakeholders: STAKEHOLDERS, values: VALUES, communication: COMMUNICATION })}\n\nCurrent date: ${date}.`];
}

export class SupervisorAgent extends Agent {
  readonly kind = 'supervisor';

  /** A supervisor session on the coder's folder, on the card. */
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
    const settings = await call<Record<string, { value: unknown }>>(this.backend, 'GET', `/settings?workspace=${encodeURIComponent(this.workspaceId)}`);
    return supervisorPromptBlocks(todayFor(settings));
  }

  /** Inspection only: the workspace kit is trimmed to its readers here, not
   *  by the readonly flag — a judge never writes, whatever mode the card is in. */
  protected toolKits(): ToolKit[] {
    return [readonlyWorkspaceToolKit, kanbanReadToolKit, webToolKit];
  }
}
