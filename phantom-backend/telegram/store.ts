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
export async function getAccount(db: Db, key: Buffer): Promise<TelegramAccountRow> {
  const rows = await db.select().from(telegramAccount).where(eq(telegramAccount.id, 1));
  if (!rows.length) {
    await db.insert(telegramAccount).values({ id: 1 }).onConflictDoNothing();
    return { mode: 'assistant', activeSessionId: null, activeWorkspaceId: null,
      webhookSecret: null, webhookUrl: null, botUsername: null };
  }
  const r = rows[0];
  let webhookSecret: string | null = null;
  if (r.webhookSecretEnc) {
    try { webhookSecret = decrypt(key, r.webhookSecretEnc); } catch { /* re-mint on next register */ }
  }
  return {
    mode: r.mode === 'code' ? 'code' : 'assistant',
    activeSessionId: r.activeSessionId, activeWorkspaceId: r.activeWorkspaceId,
    webhookSecret, webhookUrl: r.webhookUrl, botUsername: r.botUsername,
  };
}

async function patch(db: Db, values: Partial<typeof telegramAccount.$inferInsert>): Promise<void> {
  await db.insert(telegramAccount).values({ id: 1, ...values })
    .onConflictDoUpdate({ target: telegramAccount.id, set: values });
}

/** The transition announcements — ONE fixed line per direction, sent only
 *  when the mode actually changes. Command replies are separate. */
export const MODE_MESSAGE: Record<TelegramMode, string> = {
  code: "🤖 You're now talking to the coding agent.",
  assistant: "🏠 You're now talking to the assistant.",
};

/** Where a plain message goes. Entering code mode names the session.
 *  `announce` receives the transition line iff the mode changed; returns
 *  whether it did. */
export async function setMode(db: Db, mode: TelegramMode, sessionId: string | undefined,
  announce: (text: string) => Promise<unknown>): Promise<boolean> {
  const rows = await db.select({ mode: telegramAccount.mode }).from(telegramAccount)
    .where(eq(telegramAccount.id, 1));
  const before: TelegramMode = rows[0]?.mode === 'code' ? 'code' : 'assistant';
  await patch(db, mode === 'code'
    ? { mode, activeSessionId: sessionId }
    : { mode });
  if (before !== mode) await announce(MODE_MESSAGE[mode]);
  return before !== mode;
}

export async function setActiveWorkspace(db: Db, workspaceId: string | null): Promise<void> {
  await patch(db, { activeWorkspaceId: workspaceId });
}

export async function saveRegistration(
  db: Db, key: Buffer, secret: string, url: string, botUsername: string | null,
): Promise<void> {
  await patch(db, { webhookSecretEnc: encrypt(key, secret), webhookUrl: url, botUsername });
}

export async function clearRegistration(db: Db): Promise<void> {
  await patch(db, { webhookSecretEnc: null, webhookUrl: null });
}

/** True the FIRST time an update id is seen — Telegram retries deliveries,
 *  and the second insert loses on the primary key. Old rows are pruned in
 *  passing (they exist only to answer this). */
export async function markUpdate(db: Db, updateId: number): Promise<boolean> {
  if (!Number.isFinite(updateId)) return true;
  const r = await db.insert(telegramUpdate).values({ updateId }).onConflictDoNothing().returning();
  // Best-effort prune: ids are monotonic per bot, so anything far behind is done.
  db.delete(telegramUpdate).where(lt(telegramUpdate.updateId, updateId - 10_000))
    .catch(() => { /* housekeeping */ });
  return r.length > 0;
}

export interface SentOrigin { kind: 'assistant' | 'session'; sessionId?: string }

export async function recordSent(
  db: Db, chatId: number, messageId: number, content: string, origin: SentOrigin,
): Promise<void> {
  await db.insert(telegramSent)
    .values({ chatId, messageId, content, origin: origin.kind, originSessionId: origin.sessionId ?? null })
    .onConflictDoUpdate({
      target: [telegramSent.chatId, telegramSent.messageId],
      set: { content, origin: origin.kind, originSessionId: origin.sessionId ?? null, sentAt: sql`now()` },
    });
}

export async function deleteSent(db: Db, chatId: number, messageId: number): Promise<void> {
  await db.delete(telegramSent)
    .where(and(eq(telegramSent.chatId, chatId), eq(telegramSent.messageId, messageId)));
}

export async function getSent(db: Db, chatId: number, messageId: number):
Promise<{ content: string; origin: SentOrigin } | null> {
  const rows = await db.select().from(telegramSent)
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
