// The coding agent. Prompt: the two pieces the server froze on the row when
// the session was created (sessions.system_prompt — core/llm/prompts/coding),
// sent verbatim every turn with today's date on the workspace piece.
import { Agent, type AgentHandlers, type PhantomBackend } from 'phantom-client-sdk';
import type { CodingPrompt } from '../llm/prompts/coding/wiring.js';
import { withCurrentDate } from '../llm/prompts/template.js';
import { clockFor } from './clock.js';

export class CodingAgent extends Agent {
  readonly type = 'coding';

  static start(backend: PhantomBackend, handlers: AgentHandlers, workspaceId: string): Promise<CodingAgent> {
    return CodingAgent.create(backend, handlers, (b) => b.call('POST', '/sessions', { workspace_id: workspaceId }));
  }

  protected async systemPrompt(): Promise<string[]> {
    const prompt = this.session.row.system_prompt as CodingPrompt | null | undefined;
    if (!prompt?.base || !prompt.workspace) throw new Error(`session ${this.session.id} has no frozen coding prompt`);
    return [prompt.base, withCurrentDate(prompt.workspace, await clockFor(this.backend, this.session.workspaceId))];
  }
}
