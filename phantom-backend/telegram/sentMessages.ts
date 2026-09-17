// `telegram_sent_messages` (migrations 012, 031): one row per message the bot
// sent, recorded by the client's onSent hook. A reply or reaction update
// carries only (chat, message id); this row says which conversation the
// bubble belongs to (`sessionId`, null = the assistant's) and what it said
// (a reaction reads `content` back as audio). Keyed to its session and gone
// with it; the assistant's bubbles are never expired — deleted with the
// message.

import { eq, and, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { telegramSentMessages } from '../db/schema.js';

export interface TelegramSentMessage { content: string; sessionId: string | null }

export class TelegramSentMessages {
  constructor(private readonly db: Db) {}

  /** A message the bot sent, remembered so a reply to it can be traced. */
  async record(chatId: number, messageId: number, content: string, sessionId: string | null): Promise<void> {
    await this.db.insert(telegramSentMessages)
      .values({ chatId, messageId, content, sessionId })
      .onConflictDoUpdate({
        target: [telegramSentMessages.chatId, telegramSentMessages.messageId],
        set: { content, sessionId, sentAt: sql`now()` },
      });
  }

  async delete(chatId: number, messageId: number): Promise<void> {
    await this.db.delete(telegramSentMessages)
      .where(and(eq(telegramSentMessages.chatId, chatId), eq(telegramSentMessages.messageId, messageId)));
  }

  async get(chatId: number, messageId: number): Promise<TelegramSentMessage | null> {
    const rows = await this.db.select({ content: telegramSentMessages.content, sessionId: telegramSentMessages.sessionId })
      .from(telegramSentMessages)
      .where(and(eq(telegramSentMessages.chatId, chatId), eq(telegramSentMessages.messageId, messageId)));
    return rows[0] ?? null;
  }

  /** The newest thing the bot said for a session — shown when switching into
   *  code mode so the user sees where the agent left off. */
  async lastForSession(chatId: number, sessionId: string): Promise<string | null> {
    const rows = await this.db.select({ content: telegramSentMessages.content })
      .from(telegramSentMessages)
      .where(and(eq(telegramSentMessages.chatId, chatId), eq(telegramSentMessages.sessionId, sessionId)))
      .orderBy(sql`${telegramSentMessages.sentAt} desc`)
      .limit(1);
    return rows[0]?.content ?? null;
  }
}
