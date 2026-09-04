// Minimal Telegram Bot API client — raw fetch, no library. One 429 retry
// honoring retry_after. Chunking for the 4096 limit lives in `entities.ts`
// (`splitFormatted`), because a chunk boundary has to cut the formatting spans
// as well as the text. Ported from ../shockwave (api/src/telegram/client.ts);
// the PEM-upload webhook path is dropped — the address here is always a real
// hostname (PHANTOM_BACKEND_ADDRESS), never a bare-IP self-signed cert.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Entity } from './entities.js';

/** Telegram's ceiling for anything a bot uploads. Checked before the read, so
 *  an oversize send is reported as itself, not as a generic API failure. */
export const MAX_OUTBOUND_BYTES = 50 * 1024 * 1024;

/** Which Telegram method a file goes out through. */
export type SendKind = 'photo' | 'video' | 'voice' | 'audio' | 'document';

const KIND_METHOD: Record<SendKind, { method: string; field: string }> = {
  photo: { method: 'sendPhoto', field: 'photo' },
  video: { method: 'sendVideo', field: 'video' },
  voice: { method: 'sendVoice', field: 'voice' },
  audio: { method: 'sendAudio', field: 'audio' },
  document: { method: 'sendDocument', field: 'document' },
};

// What the webhook subscribes to. Telegram sends ONLY the listed kinds and
// keeps the list until the next setWebhook — the boot reconcile re-registers
// when a kind is missing. `message_reaction` is the speak-it-back gesture.
export const ALLOWED_UPDATES = ['message', 'message_reaction'];

type TgResponse = {
  ok?: boolean;
  result?: unknown;
  description?: string;
  parameters?: { retry_after?: number };
};

async function readEnvelope(res: Response): Promise<TgResponse> {
  return (await res.json().catch(() => ({}))) as TgResponse;
}

export class TelegramClient {
  /**
   * `onSent` fires for every text bubble this client writes — sent or edited —
   * with the message number and what it now says. That is what makes ANY of
   * the bot's messages point-at-able later (a reply switches into its
   * conversation, a reaction reads it aloud): the record exists because the
   * message went out, not because the code that sent it remembered to save
   * one. NOT fired for file sends — a voice bubble's text is the spoken
   * script, which only the caller holds. `onDeleted` is the same rule pointed
   * the other way. Injected, never imported: this file keeps no db access.
   */
  constructor(
    private token: string,
    private onSent?: (messageId: number, text: string) => void,
    private onDeleted?: (messageId: number) => void,
  ) {}

  async call(method: string, body: Record<string, unknown> = {}): Promise<any> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await readEnvelope(res);
      if (res.ok && json.ok) return json.result;
      if (res.status === 429 && attempt === 0) {
        const wait = ((json.parameters?.retry_after ?? 1) * 1000) + 200;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw new Error(`telegram ${method} failed: ${json.description || res.status}`);
    }
  }

  getMe() { return this.call('getMe'); }

  /** `dropPending: false` is the boot re-register path — its whole point is a
   *  fresh allowed_updates list, and dropping the queue there would lose
   *  messages sent while the server was down. */
  setWebhook(url: string, secretToken: string, opts: { dropPending?: boolean } = {}) {
    return this.call('setWebhook', {
      url, secret_token: secretToken, allowed_updates: ALLOWED_UPDATES,
      drop_pending_updates: opts.dropPending !== false,
    });
  }
  deleteWebhook() { return this.call('deleteWebhook', { drop_pending_updates: true }); }
  getWebhookInfo() { return this.call('getWebhookInfo'); }

  /** The command menu — global, or scoped to one chat (how the menu follows
   *  the mode: assistant-mode commands at home, code-mode commands in a
   *  session). The menu is a HINT (clients cache it a few seconds); the
   *  handlers answer every command correctly regardless. */
  setMyCommands(commands: Array<{ command: string; description: string }>, chatId?: number) {
    return this.call('setMyCommands', {
      commands,
      ...(chatId != null ? { scope: { type: 'chat', chat_id: chatId } } : {}),
    });
  }

  async sendMessage(chatId: number, text: string,
    opts: { replyToMessageId?: number; entities?: Entity[] } = {}) {
    const m = await this.call('sendMessage', {
      chat_id: chatId, text,
      ...(opts.entities?.length ? { entities: opts.entities } : {}),
      ...(opts.replyToMessageId
        ? { reply_parameters: { message_id: opts.replyToMessageId, allow_sending_without_reply: true } }
        : {}),
    });
    if (m?.message_id != null) this.onSent?.(m.message_id, text);
    return m;
  }

  // An edit records too, so the streamed bubble ends up stored as what it
  // finally says. An unchanged body throws ("message is not modified") and
  // never reaches the hook — right, since the record already matches.
  async editMessageText(chatId: number, messageId: number, text: string, entities?: Entity[]) {
    const r = await this.call('editMessageText', {
      chat_id: chatId, message_id: messageId, text,
      ...(entities?.length ? { entities } : {}),
    });
    this.onSent?.(messageId, text);
    return r;
  }

  async deleteMessage(chatId: number, messageId: number) {
    const r = await this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
    this.onDeleted?.(messageId);
    return r;
  }

  sendChatAction(chatId: number, action = 'typing') {
    return this.call('sendChatAction', { chat_id: chatId, action });
  }

  /** Bots get ONE reaction per message and a new one replaces the old — the
   *  ✍ → 👍 progress signal. No emoji clears it. The emoji must be spelled
   *  EXACTLY as Telegram spells it (escape constants in engine.ts — no
   *  variation selectors, ever). */
  setMessageReaction(chatId: number, messageId: number, emoji?: string) {
    return this.call('setMessageReaction', {
      chat_id: chatId, message_id: messageId,
      reaction: emoji ? [{ type: 'emoji', emoji }] : [],
    });
  }

  /** Fetch an inbound file. Telegram's getFile caps at 20 MB — callers check
   *  the declared size first so an oversize file is declined readably. */
  async downloadFile(fileId: string): Promise<Buffer> {
    const file = await this.call('getFile', { file_id: fileId });
    if (!file?.file_path) throw new Error('Telegram did not return a file path.');
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`downloading the file failed (HTTP ${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }

  private async uploadBytes(kind: SendKind, chatId: number, data: Buffer, name: string,
    caption?: string, opts: { replyToMessageId?: number } = {}): Promise<any> {
    const { method, field } = KIND_METHOD[kind];
    if (data.length > MAX_OUTBOUND_BYTES) {
      throw new Error(`the file is ${Math.round(data.length / 1024 / 1024)} MB, over Telegram's 50 MB limit for bots.`);
    }
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set(field, new Blob([new Uint8Array(data)]), name);
    // Telegram truncates captions at 1024; longer is an API error.
    if (caption) form.set('caption', caption.slice(0, 1024));
    if (opts.replyToMessageId) {
      form.set('reply_parameters',
        JSON.stringify({ message_id: opts.replyToMessageId, allow_sending_without_reply: true }));
    }
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, { method: 'POST', body: form });
    const json = await readEnvelope(res);
    if (!(res.ok && json.ok)) throw new Error(`telegram ${method} failed: ${json.description || res.status}`);
    return json.result;
  }

  /** A voice note straight from memory — synthesis hands us bytes, and a
   *  temp file would be a step with its own failure modes. */
  sendVoiceBytes(chatId: number, data: Buffer, opts: { replyToMessageId?: number } = {}) {
    return this.uploadBytes('voice', chatId, data, 'voice.ogg', undefined, opts);
  }

  /**
   * Send a local file the way its type deserves. Photos fall back to a
   * document send: Telegram rejects images outside its dimension limits
   * (tall screenshots) even when the file is valid, and arriving as a file
   * beats not arriving.
   */
  async sendFile(kind: SendKind, chatId: number, filePath: string, caption?: string): Promise<any> {
    const data = await fs.readFile(filePath);
    const name = path.basename(filePath);
    if (kind !== 'photo') return this.uploadBytes(kind, chatId, data, name, caption);
    try {
      return await this.uploadBytes('photo', chatId, data, name, caption);
    } catch {
      return this.uploadBytes('document', chatId, data, name, caption);
    }
  }
}
