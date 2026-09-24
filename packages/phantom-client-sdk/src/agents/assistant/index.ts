// The Assistant: spoken to, its replies read aloud. Its session follows the
// one on screen (POST /sessions/:id/follow — the client's call): its
// read-only file tools open that session's folder, rebuilt when it moves
// (the workspace kit's version carries the folder id).
//
// Its kit: the board, the web, the read-only workspace tools, crons, and
// the git kit. Sessions, screens, approvals and workspace creation are the
// client's — they need what only the client has — and are added with `use()`.
import { Agent, type AgentHandlers, type SessionRow } from '../../agent.js';
import { call, type PhantomBackend } from '../../backend.js';
import type { ToolKit } from '../../toolkit.js';
import { fill } from '../../prompts/template.js';
import { STAKEHOLDERS } from '../../prompts/stakeholders.js';
import { VALUES } from '../../prompts/values.js';
import { GIT } from '../../prompts/git.js';
import { SENDING_FILES } from '../../prompts/sending.js';
import { SYSTEM } from './prompt.js';
import { workspaceToolKit } from '../../kits/workspace.js';
import { webToolKit } from '../../kits/web.js';
import { cronsToolKit } from '../../kits/crons.js';
import { kanbanToolKit } from '../../kits/kanban.js';
import { gitToolKit } from '../../kits/git.js';

export function assistantPromptBlocks(date: string): string[] {
  return [`${fill(SYSTEM, { stakeholders: STAKEHOLDERS, values: VALUES, git: GIT, sending: SENDING_FILES })}\n\nCurrent date: ${date}.`];
}

const READERS = new Set(['read', 'ls', 'find', 'grep', 'task_list', 'task_wait']);
const readonlyWorkspaceToolKit: ToolKit = {
  ...workspaceToolKit,
  name: 'workspace',
  async build(ctx) {
    // No folder yet (nothing on screen) = no file tools, not a failing build.
    if (!ctx.folderId) return {};
    const all = await workspaceToolKit.build(ctx);
    return Object.fromEntries(Object.entries(all).filter(([n]) => READERS.has(n)));
  },
};

export class AssistantAgent extends Agent {
  readonly kind = 'assistant';

  /** The assistant's session in a workspace, pointed at the session on screen (if any). */
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
  async follow(activeSessionId: string, workspaceId: string): Promise<void> {
    const row = await call<SessionRow>(this.backend, 'POST', `/sessions/${this.sessionId}/follow`,
      { workspace_id: workspaceId, session_id: activeSessionId });
    this.updateRow(row);
  }

  protected async systemPrompt(): Promise<string[]> {
    const settings = await call<Record<string, { value: unknown }>>(this.backend, 'GET', '/settings');
    const tz = typeof settings.timezone?.value === 'string' ? settings.timezone.value : 'UTC';
    return assistantPromptBlocks(new Intl.DateTimeFormat('en-CA', { timeZone: tz, dateStyle: 'short' }).format(new Date()));
  }

  protected toolKits(): ToolKit[] {
    return [
      kanbanToolKit(), readonlyWorkspaceToolKit, webToolKit, cronsToolKit,
      gitToolKit({ targetSession: () => (this.row.activeSessionId as string | null | undefined) ?? null }),
    ];
  }
}
