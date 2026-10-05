// `phantom_looper.telegram_assistant_state` (app migration 001): the ONE row,
// id pinned 1 — who answers a plain message (mode), and the session and
// project the bot points at. State, not settings: a pointer has no
// default/override semantics. The pointers are foreign keys into the SDK's
// sessions and projects: a deleted row clears them.
import { eq } from 'drizzle-orm';
import type { Drizzle } from '@phantom-agent-sdk/backend';
import { telegramAssistantState } from '../storage/schema.js';

export type TelegramMode = 'assistant' | 'code';

export interface TelegramAssistantStateRow {
  mode: TelegramMode;
  activeSessionId: string | null;
  activeProjectId: string | null;
}

export const MODE_MESSAGE: Record<TelegramMode, string> = {
  code: "🤖 You're now talking to the coding agent.",
  assistant: "🏠 You're now talking to the assistant.",
};

const EMPTY: TelegramAssistantStateRow = { mode: 'assistant', activeSessionId: null, activeProjectId: null };

export class TelegramAssistantState {
  constructor(private readonly database: Drizzle) {}

  /** The one row, created on first read. */
  async read(): Promise<TelegramAssistantStateRow> {
    const rows = await this.database.select().from(telegramAssistantState).where(eq(telegramAssistantState.id, 1));
    if (!rows.length) {
      await this.database.insert(telegramAssistantState).values({ id: 1 }).onConflictDoNothing();
      return { ...EMPTY };
    }
    const row = rows[0];
    return { mode: row.mode === 'code' ? 'code' : 'assistant', activeSessionId: row.activeSessionId, activeProjectId: row.activeProjectId };
  }

  private async patch(values: Partial<typeof telegramAssistantState.$inferInsert>): Promise<void> {
    await this.database.insert(telegramAssistantState).values({ id: 1, ...values })
      .onConflictDoUpdate({ target: telegramAssistantState.id, set: values });
  }

  /** Switch who a message goes to; says the switch aloud when it changed. */
  async setMode(mode: TelegramMode, announce: (text: string) => Promise<unknown>, message?: string): Promise<boolean> {
    const before = (await this.read()).mode;
    await this.patch({ mode });
    if (before !== mode) await announce(message ?? MODE_MESSAGE[mode]);
    return before !== mode;
  }

  /** WHICH session the bot points at — read by the Assistant's file tools in
   *  assistant mode and by the coding turn in code mode. The pointer only;
   *  the mode is untouched. The session must exist (foreign key). */
  async setActiveSession(sessionId: string): Promise<void> {
    await this.patch({ activeSessionId: sessionId });
  }

  /** The project /new opens sessions in. Must exist (foreign key). */
  async setActiveProject(projectId: string | null): Promise<void> {
    await this.patch({ activeProjectId: projectId });
  }
}
