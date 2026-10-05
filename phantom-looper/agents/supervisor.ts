// The supervisor — the judge in a card run. Its system prompt layout: its
// own document (phantom-looper/prompts/supervisor) and the date. Its session is
// conversation-only, on the coder's workspace (the type borrows). The run's
// card-bound powers are the supervisor's own tools for that run, added with
// `addToolKit()`.
import { Agent, agentText, type AgentHandlers, type BackendClient, type SystemPromptLayout } from '@phantom-agent-sdk/client';
import { systemPrompt as supervisorInstructions } from '../prompts/supervisor/wiring.js';

export class SupervisorAgent extends Agent {
  readonly type = 'supervisor';

  static readonly systemPromptLayout: SystemPromptLayout = {
    stable: [agentText(supervisorInstructions())],
    context: [],
    volatile: ['time_date'],
  };

  /** A new supervisor session reading the coder's workspace. */
  static newSession(backend: BackendClient, handlers: AgentHandlers,
    opts: { projectId: string; coderSessionId: string }): Promise<SupervisorAgent> {
    return SupervisorAgent.create(backend, handlers, (connection) => connection.call('POST', '/sessions',
      { project_id: opts.projectId, type: 'supervisor', workspace_session_id: opts.coderSessionId,
        system_prompt_layout: SupervisorAgent.systemPromptLayout }));
  }
}
