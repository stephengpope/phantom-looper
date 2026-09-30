// The supervisor — the judge in a card run. Prompt: core/llm/prompts/supervisor,
// built every turn with today's date. Its session is conversation-only, on
// the coder's folder. The run's card-bound powers are the supervisor's own tools for that run,
// added with `use()`.
import { Agent, type AgentHandlers, type PhantomBackend } from 'phantom-client-sdk';
import { systemPrompt as supervisorInstructions } from '../llm/prompts/supervisor/wiring.js';
import { withCurrentDate } from '../llm/prompts/template.js';
import { clockFor } from './clock.js';

export class SupervisorAgent extends Agent {
  readonly type = 'supervisor';

  static start(backend: PhantomBackend, handlers: AgentHandlers,
    opts: { workspaceId: string; folderId: string; cardId: number }): Promise<SupervisorAgent> {
    return SupervisorAgent.create(backend, handlers, (b) => b.call('POST', '/sessions/supervisor',
      { workspace_id: opts.workspaceId, folder_id: opts.folderId, card_id: opts.cardId }));
  }

  protected async systemPrompt(): Promise<string[]> {
    return [withCurrentDate(supervisorInstructions(), await clockFor(this.backend, this.session.workspaceId))];
  }
}
