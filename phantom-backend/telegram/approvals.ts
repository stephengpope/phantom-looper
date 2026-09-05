// The Telegram approval gate — the server-side twin of the cli's (App.tsx
// "the approval gate"). A gated tool (today: workspace_create_repo) calls
// `request` and waits; the user sees ONE bubble — what kind, the exact subject
// about to exist, an [Accept] [Decline] inline keyboard — and answers by
// tapping, or by saying the exact word ("accept" / "decline" as a text or a
// voice note; exact match like the wake word, never interpretation).
//
// Rules, the same as the cli's: ONE ask at a time per chat; the tool call's
// abort (the user hit /stop) declines, so a dead turn cannot leave a question
// standing that nothing would answer; the answer is final — the buttons come
// off the bubble and its text says what was decided. One rule is Telegram's
// own: ANY other message while an ask stands declines it (the cli swallows
// such text; on Telegram the message is the user's correction — "no, call it
// foo" — and it must reach the Assistant, which happens because the turn ends
// and the queued message runs as the follow-up).
//
// In-memory: a restart forgets a pending ask; a late tap on its buttons gets
// "that question has expired" and nothing happens. Nothing is stored.

import crypto from 'node:crypto';

/** The slice of TelegramClient this needs — injected so a test can fake it. */
export interface ApprovalClient {
  sendMessage(chatId: number, text: string, opts?: { replyMarkup?: unknown }): Promise<{ message_id?: number } | undefined>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<unknown>;
  answerCallbackQuery(id: string, text?: string): Promise<unknown>;
}

export interface Ask { label: string; subject: string }

interface Pending extends Ask {
  id: string;
  chatId: number;
  messageId: number | null;
  resolve: (ok: boolean) => void;
}

const PREFIX = 'apv';
const ACCEPT = 'accept';
const DECLINE = 'decline';

/** The bubble's text: kind, subject on its own line, the how-to. */
export function askText(ask: Ask): string {
  return `❔ ${ask.label}\n${ask.subject}\n\nAccept or decline below — or just say the word.`;
}

/** The bubble once answered — the same kind + subject, then the verdict. */
export function answeredText(ask: Ask, ok: boolean): string {
  return `${ok ? '✅' : '✖️'} ${ask.label}\n${ask.subject}\n\n${ok ? 'Accepted.' : 'Declined.'}`;
}

/** The exact-word answer: "Accept!" → true, "decline" → false, anything else null. */
export function parseAnswer(text: string): boolean | null {
  const word = text.toLowerCase().replace(/[^a-z]/g, '');
  if (word === ACCEPT) return true;
  if (word === DECLINE) return false;
  return null;
}

export class Approvals {
  private pending = new Map<number, Pending>();

  /** Is a question standing in this chat? */
  has(chatId: number): boolean { return this.pending.has(chatId); }

  /** Ask, and wait for the answer. Rejects nothing: a second ask while one
   *  stands resolves false at once (the tool reports it), an abort resolves
   *  false, a failed send resolves false. */
  request(client: ApprovalClient, chatId: number, ask: Ask, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (signal?.aborted || this.pending.has(chatId)) { resolve(false); return; }
      const id = crypto.randomBytes(6).toString('hex');
      const entry: Pending = { ...ask, id, chatId, messageId: null, resolve: () => {} };
      const done = (ok: boolean) => {
        if (this.pending.get(chatId) !== entry) return;   // already answered
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(chatId);
        if (entry.messageId != null) {
          client.editMessageText(chatId, entry.messageId, answeredText(ask, ok)).catch(() => {});
        }
        resolve(ok);
      };
      const onAbort = () => done(false);
      entry.resolve = done;
      signal?.addEventListener('abort', onAbort);
      this.pending.set(chatId, entry);

      client.sendMessage(chatId, askText(ask), {
        replyMarkup: { inline_keyboard: [[
          { text: '✅ Accept', callback_data: `${PREFIX}:${id}:y` },
          { text: '✖️ Decline', callback_data: `${PREFIX}:${id}:n` },
        ]] },
      }).then((m) => { entry.messageId = m?.message_id ?? null; }, () => done(false));
    });
  }

  /** A button tap. Answers the query (mandatory — the client spins until we
   *  do), then resolves the ask it belongs to. A tap on a stale bubble says so. */
  async handleCallback(client: ApprovalClient, chatId: number, query: { id: string; data?: string }): Promise<void> {
    const [prefix, id, verdict] = String(query.data ?? '').split(':');
    const entry = this.pending.get(chatId);
    if (prefix !== PREFIX || !entry || entry.id !== id) {
      await client.answerCallbackQuery(query.id, 'That question has expired.').catch(() => {});
      return;
    }
    await client.answerCallbackQuery(query.id).catch(() => {});
    entry.resolve(verdict === 'y');
  }

  /** A plain message while an ask stands. The exact word answers it; any other
   *  message declines it and is NOT consumed (returns false) so it runs as the
   *  follow-up. Returns true when the text was the answer and nothing else. */
  handleText(chatId: number, text: string): boolean {
    const entry = this.pending.get(chatId);
    if (!entry) return false;
    const answer = parseAnswer(text);
    entry.resolve(answer ?? false);
    return answer !== null;
  }
}
