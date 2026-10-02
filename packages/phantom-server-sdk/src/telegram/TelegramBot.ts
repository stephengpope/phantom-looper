// TelegramBot — the Bot API client (raw fetch, no library), the webhook
// registration and its secret (the link row), and the one door every
// inbound update goes through to user space. The SDK answers nothing on
// its own. Stub.
export interface TelegramUpdate { update_id: number; message?: Record<string, unknown>; callback_query?: Record<string, unknown> }
export interface TelegramLink { webhookUrl: string | null; botUsername: string | null; registeredAt: Date | null }
export type TelegramEntity = { type: string; offset: number; length: number; url?: string; language?: string };

export class TelegramBot {
  // ── the link ──────────────────────────────────────────────────────────
  /** Register the webhook with Telegram when enabled, token, authorized user and address are all set; tear down otherwise. */
  async reconcileWebhook(): Promise<TelegramLink> { throw stub(); }
  async link(): Promise<TelegramLink> { throw stub(); }
  /** Is this sender the authorized user? */
  isAuthorized(userId: number): boolean { throw stub(); }
  /** Every verified, unduplicated update, handed to user space. */
  onUpdate(handler: (update: TelegramUpdate) => Promise<void>): () => void { throw stub(); }
  // ── sending ───────────────────────────────────────────────────────────
  async sendText(chatId: number, text: string, options?: { entities?: TelegramEntity[]; replyToMessageId?: number; replyMarkup?: unknown }): Promise<{ messageId: number }> { throw stub(); }
  async sendMarkdown(chatId: number, markdown: string, options?: { replyToMessageId?: number }): Promise<{ messageId: number }> { throw stub(); }
  async editText(chatId: number, messageId: number, text: string, entities?: TelegramEntity[]): Promise<void> { throw stub(); }
  async deleteMessage(chatId: number, messageId: number): Promise<void> { throw stub(); }
  async sendFile(chatId: number, filePath: string, options?: { as?: 'photo' | 'video' | 'audio' | 'voice' | 'document'; caption?: string }): Promise<{ messageId: number }> { throw stub(); }
  async sendVoice(chatId: number, audio: Buffer): Promise<{ messageId: number }> { throw stub(); }
  async sendChatAction(chatId: number, action?: string): Promise<void> { throw stub(); }
  async setReaction(chatId: number, messageId: number, emoji?: string): Promise<void> { throw stub(); }
  async answerCallback(callbackQueryId: string, text?: string): Promise<void> { throw stub(); }
  async setCommands(commands: Array<{ command: string; description: string }>): Promise<void> { throw stub(); }
  async downloadFile(fileId: string): Promise<{ data: Buffer; path: string }> { throw stub(); }
}
const stub = () => new Error('stub');
