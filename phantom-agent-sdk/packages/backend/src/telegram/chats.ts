// `telegram_chats` and `telegram_link_codes` (061): which chat is whose. A
// user's app asks for a link (a one-time code, shown as t.me/<bot>?start=…);
// the chat that sends it to the bot becomes theirs — their private chat, or
// a group for one project. The service role's own chat is not a row: it is the
// `telegram_authorized_user` setting, as the cli has always set it.
//
// Reads and writes for a user go through the acting handle (the policies
// keep them to their own links); the bot's inbound lookups run as the
// server, before anyone is known.
import { randomBytes } from 'node:crypto';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { newId } from '@phantom-agent-sdk/client';
import type { Drizzle } from '../storage/Database.js';
import { telegramChats, telegramLinkCodes, type TelegramChatRow } from '../storage/schema.js';
import { SERVICE_ROLE_ORGANIZATION } from '../lib/scopes.js';

const CODE_MINUTES = 10;

/** Who a chat speaks for. `serviceRole`: the server's own chat (the setting). */
export interface ChatLink {
  id: string;
  chatId: number;
  telegramUserId: number;
  organizationId: string;
  userId: string | null;
  projectId: string | null;
  serviceRole: boolean;
}

const fromRow = (row: TelegramChatRow): ChatLink => ({ id: row.id, chatId: row.chatId, telegramUserId: row.telegramUserId,
  organizationId: row.organizationId, userId: row.userId, projectId: row.projectId, serviceRole: false });

/** The service role's chat, from the setting: private, so chat id = their Telegram id. */
export const serviceRoleLink = (chatId: number): ChatLink => ({ id: 'service_role', chatId, telegramUserId: chatId,
  organizationId: SERVICE_ROLE_ORGANIZATION, userId: null, projectId: null, serviceRole: true });

export class TelegramChats {
  /** `database`: the acting handle (a user's own rows); `system`: the
   *  server's, for the bot's lookups. */
  constructor(private readonly database: Drizzle, private readonly system: Drizzle) {}

  /** A one-time code for the caller (and, optionally, one project of theirs). */
  async newCode(projectId: string | null): Promise<{ code: string; expiresAt: Date }> {
    const code = randomBytes(18).toString('base64url');
    const expiresAt = new Date(Date.now() + CODE_MINUTES * 60_000);
    await this.database.insert(telegramLinkCodes).values({ code, projectId, expiresAt });
    await this.system.delete(telegramLinkCodes).where(lt(telegramLinkCodes.expiresAt, new Date()));
    return { code, expiresAt };
  }

  /** The bot heard a code: the chat becomes the code's owner's. Null when the
   *  code is unknown or expired. One-time: the code goes either way. */
  async redeem(code: string, chatId: number, telegramUserId: number): Promise<ChatLink | null> {
    const [pending] = await this.system.delete(telegramLinkCodes)
      .where(and(eq(telegramLinkCodes.code, code), gt(telegramLinkCodes.expiresAt, new Date()))).returning();
    if (!pending) return null;
    const values = { chatId, telegramUserId, organizationId: pending.organizationId, userId: pending.userId, projectId: pending.projectId };
    const [row] = await this.system.insert(telegramChats).values({ id: newId(), ...values })
      .onConflictDoUpdate({ target: telegramChats.chatId, set: values }).returning();
    return fromRow(row);
  }

  /** The link for a chat, or null when it is not linked. */
  async byChat(chatId: number): Promise<ChatLink | null> {
    const [row] = await this.system.select().from(telegramChats).where(eq(telegramChats.chatId, chatId));
    return row ? fromRow(row) : null;
  }

  /** Where a user's word about one project goes: the chat linked to that
   *  project, else their private chat. `userId` null: a project chat only. */
  async forOwner(organizationId: string, userId: string | null, projectId: string): Promise<ChatLink | null> {
    const rows = await this.system.select().from(telegramChats).where(and(
      eq(telegramChats.organizationId, organizationId),
      userId ? eq(telegramChats.userId, userId) : sql`true`,
      sql`(${telegramChats.projectId} = ${projectId} or ${telegramChats.projectId} is null)`));
    const own = rows.find((row) => row.projectId === projectId) ?? (userId ? rows.find((row) => row.projectId === null) : undefined);
    return own ? fromRow(own) : null;
  }

  /** The caller's own links. */
  async list(): Promise<ChatLink[]> {
    return (await this.database.select().from(telegramChats)).map(fromRow);
  }

  /** Unlink one of the caller's chats. False when it is not theirs (or gone). */
  async remove(id: string): Promise<boolean> {
    return (await this.database.delete(telegramChats).where(eq(telegramChats.id, id)).returning({ id: telegramChats.id })).length > 0;
  }
}

