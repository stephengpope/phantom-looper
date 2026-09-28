// The coding agent, built on the SDK's Agent runtime.
//
// Prompt: the two pieces the server froze on the row when the session was
// created (sessions.system_prompt — core/llm/prompts/coding). Sent verbatim
// every turn, with today's date appended to the workspace piece at every
// turn, never stored — the same rule the previous agent build followed.
//
// Kit: the file and task tools, skills, web, secrets, crons, the database,
// the card read, and send_message. A host adds card-bound tools of its own
// (the looper's kanban_card_block) with `use()`.
import {
  Agent, call, type AgentHandlers, type PhantomBackend, type SessionRow, type ToolKit,
  workspaceToolKit, skillsToolKit, webToolKit, secretsToolKit, cronsToolKit, databaseToolKit, kanbanReadToolKit, notifyToolKit,
} from 'phantom-client-sdk';
import type { CodingPrompt } from '../llm/prompts/coding/wiring.js';
import { withCurrentDate } from '../llm/prompts/template.js';
import { clockFor } from './clock.js';

export class CodingAgent extends Agent {
  readonly kind = 'coding';

  static create(backend: PhantomBackend, handlers: AgentHandlers, opts: { workspaceId: string }): Promise<CodingAgent> {
    return Agent.birth<CodingAgent>(CodingAgent, backend, handlers,
      () => call<SessionRow>(backend, 'POST', '/sessions', { workspace_id: opts.workspaceId }));
  }

  static resume(backend: PhantomBackend, handlers: AgentHandlers, sessionId: string): Promise<CodingAgent> {
    return Agent.wake<CodingAgent>(CodingAgent, backend, handlers, sessionId);
  }

  protected async systemPrompt(): Promise<string[]> {
    const prompt = this.row.system_prompt as CodingPrompt | null | undefined;
    if (!prompt?.base || !prompt.workspace) throw new Error(`session ${this.sessionId} has no frozen coding prompt`);
    return [prompt.base, withCurrentDate(prompt.workspace, await clockFor(this.backend, this.workspaceId))];
  }

  protected toolKits(): ToolKit[] {
    return [workspaceToolKit, skillsToolKit, webToolKit, secretsToolKit, cronsToolKit, databaseToolKit, kanbanReadToolKit, notifyToolKit];
  }
}
