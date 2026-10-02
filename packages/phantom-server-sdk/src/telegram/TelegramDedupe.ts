// TelegramDedupe — two small tables: updates already handled (Telegram
// re-delivers what it did not get a 200 for), and messages the bot sent
// (a reply or reaction carries only chat + message id; this says which
// session it belongs to). Stub.
export class TelegramDedupe {
  /** True the first time; false for a re-delivery. */
  async markHandled(updateId: number): Promise<boolean> { throw stub(); }
  async recordSent(chatId: number, messageId: number, content: string, sessionId: string | null): Promise<void> { throw stub(); }
  async sentMessage(chatId: number, messageId: number): Promise<{ content: string; sessionId: string | null } | undefined> { throw stub(); }
  async lastSentForSession(chatId: number, sessionId: string): Promise<{ messageId: number } | undefined> { throw stub(); }
  async forgetSent(chatId: number, messageId: number): Promise<void> { throw stub(); }
}
const stub = () => new Error('stub');
