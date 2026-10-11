// `phantom_looper.telegram_chat_state` (app migration 003): one row per
// linked chat — who answers a plain message there (mode), and the session
// and project that chat points at. State, not settings: a pointer has no
// default/override semantics. The pointers are foreign keys into the SDK's
// sessions and projects: a deleted row clears them.
import { eq } from 'drizzle-orm';
import type { Drizzle } from '@phantom-agent-sdk/backend';
import { telegramChatState } from '../storage/schema.js';
import { STREAM_MODES, type TelegramStream } from './watch.js';

export type TelegramMode = 'assistant' | 'code';

export interface TelegramAssistantStateRow {
  mode: TelegramMode;
  activeSessionId: string | null;
  activeProjectId: string | null;
  /** What of the session the chat is on streams in (telegram/watch.ts). */
  stream: TelegramStream;
  /** The chat's own assistant conversation; null until the first assistant turn. */
  assistantSessionId: string | null;
}

export const MODE_MESSAGE: Record<TelegramMode, string> = {
  code: "🤖 You're now talking to the coding agent.",
  assistant: "🏠 You're now talking to the assistant.",
};

const EMPTY: TelegramAssistantStateRow = { mode: 'assistant', activeSessionId: null, activeProjectId: null, stream: 'on', assistantSessionId: null };

export class TelegramAssistantState {
  constructor(private readonly database: Drizzle) {}

  /** A chat's row, created on first read. */
  async read(chatId: number): Promise<TelegramAssistantStateRow> {
    const rows = await this.database.select().from(telegramChatState).where(eq(telegramChatState.chatId, chatId));
    if (!rows.length) {
      await this.database.insert(telegramChatState).values({ chatId }).onConflictDoNothing();
      return { ...EMPTY };
    }
    const row = rows[0];
    return { mode: row.mode === 'code' ? 'code' : 'assistant', activeSessionId: row.activeSessionId, activeProjectId: row.activeProjectId,
      stream: (STREAM_MODES as readonly string[]).includes(row.stream) ? row.stream as TelegramStream : 'on',
      assistantSessionId: row.assistantSessionId };
  }

  private async patch(chatId: number, values: Omit<Partial<typeof telegramChatState.$inferInsert>, 'chatId'>): Promise<void> {
    await this.database.insert(telegramChatState).values({ chatId, ...values })
      .onConflictDoUpdate({ target: telegramChatState.chatId, set: values });
  }

  /** Switch who a message goes to; says the switch aloud when it changed. */
  async setMode(chatId: number, mode: TelegramMode, announce: (text: string) => Promise<unknown>, message?: string): Promise<boolean> {
    const before = (await this.read(chatId)).mode;
    await this.patch(chatId, { mode });
    if (before !== mode) await announce(message ?? MODE_MESSAGE[mode]);
    return before !== mode;
  }

  /** WHICH session the bot points at — read by the Assistant's file tools in
   *  assistant mode and by the coding turn in code mode. The pointer only;
   *  the mode is untouched. The session must exist (foreign key). */
  async setActiveSession(chatId: number, sessionId: string): Promise<void> {
    await this.patch(chatId, { activeSessionId: sessionId });
  }

  /** The chat's assistant session: set when one is made, cleared when it is
   *  found gone. The session must exist (foreign key). */
  async setAssistantSession(chatId: number, sessionId: string | null): Promise<void> {
    await this.patch(chatId, { assistantSessionId: sessionId });
  }

  /** /stream — what of the session the chat is on streams in. */
  async setStream(chatId: number, stream: TelegramStream): Promise<void> {
    await this.patch(chatId, { stream });
  }

  /** The project /new opens sessions in. Must exist (foreign key). */
  async setActiveProject(chatId: number, projectId: string | null): Promise<void> {
    await this.patch(chatId, { activeProjectId: projectId });
  }
}
