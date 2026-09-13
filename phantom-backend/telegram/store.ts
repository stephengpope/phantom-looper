// Telegram's rows (migration 012): the ONE account row, the sent-bubble map,
// and update dedup. State, not settings — an active-session pointer has no
// default/override semantics. The webhook secret is encrypted at rest like
// every stored credential.

import { eq, and, sql, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { telegramAccount, telegramSent, telegramUpdate } from '../db/schema.js';
import { encrypt, decrypt } from '../crypto.js';

export type TelegramMode = 'assistant' | 'code';

export interface TelegramAccountRow {
  mode: TelegramMode;
  activeSessionId: string | null;
  activeWorkspaceId: string | null;
  webhookSecret: string | null;
  webhookUrl: string | null;
  botUsername: string | null;
}

/** The account row, minted on first read — one row, id pinned 1. */
export const MODE_MESSAGE: Record<TelegramMode, string> = {
  code: "🤖 You're now talking to the coding agent.",
  assistant: "🏠 You're now talking to the assistant.",
};

export interface SentOrigin { kind: 'assistant' | 'session'; sessionId?: string }

export class TelegramState {
  constructor(private readonly db: Db, private readonly encryptionKey: Buffer) {}

  /** The one account row (id 1), created on first read. */
  async account(): Promise<TelegramAccountRow> {
  const rows = await this.db.select().from(telegramAccount).where(eq(telegramAccount.id, 1));
  if (!rows.length) {
    await this.db.insert(telegramAccount).values({ id: 1 }).onConflictDoNothing();
    return { mode: 'assistant', activeSessionId: null, activeWorkspaceId: null,
      webhookSecret: null, webhookUrl: null, botUsername: null };
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

  private async patch(values: Partial<typeof telegramAccount.$inferInsert>): Promise<void> {
  await this.db.insert(telegramAccount).values({ id: 1, ...values })
    .onConflictDoUpdate({ target: telegramAccount.id, set: values });
}

/** The transition announcements — ONE fixed line per direction, sent only
 *  when the mode actually changes. Command replies are separate. */

/** WHO answers a plain message — the mode, and only the mode. WHICH session
 *  is `setActiveSession`; the two are independent knobs, never written
 *  together. `announce` receives the transition line iff the mode changed;
 *  returns whether it did. Pass `message` to override the default
 *  MODE_MESSAGE — enterMode does this for code mode so the line carries
 *  session context. */
  /** Switch who a message goes to; says the switch aloud when it changed. */
  async setMode(mode: TelegramMode, announce: (text: string) => Promise<unknown>, message?: string): Promise<boolean> {
  const rows = await this.db.select({ mode: telegramAccount.mode }).from(telegramAccount)
    .where(eq(telegramAccount.id, 1));
  const before: TelegramMode = rows[0]?.mode === 'code' ? 'code' : 'assistant';
  await this.patch({ mode });
  if (before !== mode) await announce(message ?? MODE_MESSAGE[mode]);
  return before !== mode;
}

/** WHICH session the account points at — read by the Assistant's file tools
 *  in assistant mode and by the coding turn in code mode. Changes the pointer
 *  only; the mode is untouched. */
  async setActiveSession(sessionId: string): Promise<void> {
  await this.patch({ activeSessionId: sessionId });
}

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

/** True the FIRST time an update id is seen — Telegram retries deliveries,
 *  and the second insert loses on the primary key. Old rows are pruned in
 *  passing (they exist only to answer this). */
  async markUpdate(updateId: number): Promise<boolean> {
  if (!Number.isFinite(updateId)) return true;
  const r = await this.db.insert(telegramUpdate).values({ updateId }).onConflictDoNothing().returning();
  // Best-effort prune: ids are monotonic per bot, so anything far behind is done.
  this.db.delete(telegramUpdate).where(lt(telegramUpdate.updateId, updateId - 10_000))
    .catch(() => { /* housekeeping */ });
  return r.length > 0;
}


  /** A message the bot sent, remembered so a reply to it can be traced. */
  async recordSent(chatId: number, messageId: number, content: string, origin: SentOrigin): Promise<void> {
  await this.db.insert(telegramSent)
    .values({ chatId, messageId, content, origin: origin.kind, originSessionId: origin.sessionId ?? null })
    .onConflictDoUpdate({
      target: [telegramSent.chatId, telegramSent.messageId],
      set: { content, origin: origin.kind, originSessionId: origin.sessionId ?? null, sentAt: sql`now()` },
    });
}

  async deleteSent(chatId: number, messageId: number): Promise<void> {
  await this.db.delete(telegramSent)
    .where(and(eq(telegramSent.chatId, chatId), eq(telegramSent.messageId, messageId)));
}

  async getSent(chatId: number, messageId: number): Promise<{ content: string; origin: SentOrigin } | null> {
  const rows = await this.db.select().from(telegramSent)
    .where(and(eq(telegramSent.chatId, chatId), eq(telegramSent.messageId, messageId)));
  if (!rows.length) return null;
  const r = rows[0];
  return {
    content: r.content,
    origin: r.origin === 'session' && r.originSessionId
      ? { kind: 'session', sessionId: r.originSessionId }
      : { kind: 'assistant' },
  };
}
}
