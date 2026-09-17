// `telegram_bot_state` (migrations 012, 031): the ONE row, id pinned 1 — who
// answers a plain message (mode), the active session and workspace, and the
// webhook registration. State, not settings: a pointer has no
// default/override semantics. The webhook secret is encrypted at rest like
// every stored credential. The pointers are foreign keys: a deleted session
// or workspace clears them, so no reader guards against a phantom.

import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { telegramBotState } from '../db/schema.js';
import { encrypt, decrypt } from '../crypto.js';

export type TelegramMode = 'assistant' | 'code';

export interface TelegramBotStateRow {
  mode: TelegramMode;
  activeSessionId: string | null;
  activeWorkspaceId: string | null;
  webhookSecret: string | null;
  webhookUrl: string | null;
  botUsername: string | null;
}

export const MODE_MESSAGE: Record<TelegramMode, string> = {
  code: "🤖 You're now talking to the coding agent.",
  assistant: "🏠 You're now talking to the assistant.",
};

const EMPTY: TelegramBotStateRow = { mode: 'assistant', activeSessionId: null, activeWorkspaceId: null,
  webhookSecret: null, webhookUrl: null, botUsername: null };

export class TelegramBotState {
  constructor(private readonly db: Db, private readonly encryptionKey: Buffer) {}

  /** The one row, created on first read. */
  async read(): Promise<TelegramBotStateRow> {
    const rows = await this.db.select().from(telegramBotState).where(eq(telegramBotState.id, 1));
    if (!rows.length) {
      await this.db.insert(telegramBotState).values({ id: 1 }).onConflictDoNothing();
      return { ...EMPTY };
    }
    const r = rows[0];
    let webhookSecret: string | null = null;
    if (r.webhookSecretEnc) {
      try { webhookSecret = decrypt(this.encryptionKey, r.webhookSecretEnc); } catch { /* re-mint on next register */ }
    }
    return {
      mode: r.mode === 'code' ? 'code' : 'assistant',
      activeSessionId: r.activeSessionId, activeWorkspaceId: r.activeWorkspaceId,
      webhookSecret, webhookUrl: r.webhookUrl, botUsername: r.botUsername,
    };
  }

  private async patch(values: Partial<typeof telegramBotState.$inferInsert>): Promise<void> {
    await this.db.insert(telegramBotState).values({ id: 1, ...values })
      .onConflictDoUpdate({ target: telegramBotState.id, set: values });
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

  /** The workspace /new opens sessions in. Must exist (foreign key). */
  async setActiveWorkspace(workspaceId: string | null): Promise<void> {
    await this.patch({ activeWorkspaceId: workspaceId });
  }

  /** The webhook is registered: its secret (encrypted at rest), URL and bot. */
  async saveRegistration(secret: string, url: string, botUsername: string | null): Promise<void> {
    await this.patch({ webhookSecretEnc: encrypt(this.encryptionKey, secret), webhookUrl: url, botUsername });
  }

  async clearRegistration(): Promise<void> {
    await this.patch({ webhookSecretEnc: null, webhookUrl: null });
  }
}
