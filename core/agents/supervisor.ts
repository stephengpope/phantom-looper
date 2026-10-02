// The supervisor — the judge in a card run. Its system prompt layout: its
// own document (core/prompts/supervisor) and the date. Its session is
// conversation-only, on the coder's workspace. The run's card-bound powers are
// the supervisor's own tools for that run, added with `addToolKit()`.
import { Agent, agentText, type AgentHandlers, type BackendClient, type SystemPromptLayout } from 'phantom-client-sdk';
import { systemPrompt as supervisorInstructions } from '../prompts/supervisor/wiring.js';

export class SupervisorAgent extends Agent {
  readonly type = 'supervisor';

  static readonly systemPromptLayout: SystemPromptLayout = {
    stable: [agentText(supervisorInstructions())],
    context: [],
    volatile: ['time_date'],
  };

  static newSession(backend: BackendClient, handlers: AgentHandlers,
    opts: { projectId: string; workspaceId: string; cardId: number }): Promise<SupervisorAgent> {
    return SupervisorAgent.create(backend, handlers, (b) => b.call('POST', '/sessions/supervisor',
      { project_id: opts.projectId, workspace_id: opts.workspaceId, card_id: opts.cardId,
        system_prompt_layout: SupervisorAgent.systemPromptLayout }));
  }
}
