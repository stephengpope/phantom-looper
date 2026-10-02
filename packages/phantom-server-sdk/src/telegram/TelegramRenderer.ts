// TelegramRenderer — what Telegram actually wants: markdown as plain text
// plus formatting spans, split at 4096; the files an agent named in its
// text (MEDIA: tags and bare /workspace paths) as deliverables; and the
// live-feed bubble (the "…" placeholder edited in place as the reply
// streams). Stub.
import type { TelegramEntity } from './TelegramBot.js';

export interface Formatted { text: string; entities: TelegramEntity[] }
export interface Deliverable { path: string; as: 'photo' | 'video' | 'audio' | 'voice' | 'document' }
export interface LiveBubble { part(part: Record<string, unknown>): void; done(finalText: string): Promise<void>; dispose(): void }

export class TelegramRenderer {
  toFormatted(markdown: string): Formatted { throw stub(); }
  split(formatted: Formatted, limit?: number): Formatted[] { throw stub(); }
  /** The text with its file tags removed, and the files to send. */
  async extractDeliverables(text: string, workspaceId: string): Promise<{ text: string; files: Deliverable[] }> { throw stub(); }
  /** Start rendering a session's turn into one chat. */
  openBubble(chatId: number, sessionId: string, options: { replyMode: 'text' | 'voice' | 'both' }): LiveBubble { throw stub(); }
}
const stub = () => new Error('stub');
