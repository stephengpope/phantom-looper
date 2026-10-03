// The coding agent. Its system prompt layout: the agent's own text
// (core/prompts/coding) around the blocks the server fills — the repo's
// SOUL.md first, AGENTS.md opening the context section, the GitHub token
// and database lines where they belong, skills / date / secrets last.
// Assembled once when the session is created; sent as stored every turn.
import { Agent, agentText, type AgentHandlers, type BackendClient, type SystemPromptLayout } from 'phantom-client-sdk';
import { codingAgentText, codingGitText, codingEnvironmentText, codingSendingText } from '../prompts/coding/wiring.js';

export class CodingAgent extends Agent {
  readonly type = 'coding';

  static readonly systemPromptLayout: SystemPromptLayout = {
    stable: ['soul_md', agentText(codingAgentText())],
    context: ['agents_md', agentText(codingGitText()), 'github_token', agentText(codingEnvironmentText()), 'agent_database', agentText(codingSendingText())],
    volatile: ['skills_list', 'time_date', 'secrets_list'],
  };

  static newSession(backend: BackendClient, handlers: AgentHandlers, projectId: string): Promise<CodingAgent> {
    return CodingAgent.create(backend, handlers, (b) => b.call('POST', '/sessions',
      { project_id: projectId, type: 'coding', system_prompt_layout: CodingAgent.systemPromptLayout }));
  }
}
