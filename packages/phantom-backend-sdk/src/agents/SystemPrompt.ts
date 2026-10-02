// SystemPrompt — fills an agent's prompt LAYOUT (three sections, each the
// agent's own text or the name of a server block) from a session's facts.
// Assembled once when the session is created; rebuilt only on the
// deliberate rebuild. The blocks only the server can fill: soul_md,
// agents_md, skills_list, secrets_list, time_date, github_token,
// agent_database. Stub.
import type { SystemPromptLayout, StoredSystemPrompt } from 'phantom-client-sdk/systemPrompt';

export type ServerPromptBlockName = 'soul_md' | 'agents_md' | 'skills_list' | 'secrets_list' | 'time_date' | 'github_token' | 'agent_database';
export interface SystemPromptSource { projectId: string; workspaceId: string | null }

export class SystemPrompt {
  /** Refuse a layout naming a block the server does not have. Before a row exists. */
  check(layout: SystemPromptLayout): void { throw stub(); }
  /** Fill the layout from the session's project, checkout, settings and image. */
  async assemble(layout: SystemPromptLayout, source: SystemPromptSource): Promise<StoredSystemPrompt> { throw stub(); }
  blockNames(): ServerPromptBlockName[] { throw stub(); }
}
const stub = () => new Error('stub');
