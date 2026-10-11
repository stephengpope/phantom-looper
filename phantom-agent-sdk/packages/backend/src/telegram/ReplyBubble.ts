// A reply bubble: one turn's reply as the chat sees it.
//
// The reply is a list of BLOCKS in the order the turn produced them — a text
// segment, a tool call — and, at the end while nothing has arrived yet, a
// waiting line: the "..." dots before the first output, "💭 thinking" after a
// tool. Every block is one chat message.
//
//   - The dots are a slot: the first text or tool line that arrives takes the
//     message over, so the wait becomes the answer in place.
//   - A thinking line is closed with a ✓ when the model moves on, and the
//     next block is a new message below it; a thinking line still open when
//     the turn ends receives the reply.
//
// One timer draws it. Every tick each block's text is computed from the
// model above and compared with what its message says; only what differs is
// sent or edited, in block order. Telegram allows about one edit a second
// on a message, which is the tick, so the dots move at the tick and a tool's
// elapsed counter steps every few seconds. A send or edit that fails is
// logged and corrected by the next tick; nothing here is swallowed.
//
// finish() posts the authoritative final text once (formatted, chunked under
// Telegram's 4096), then the files it named. discard() takes down a wait
// that never became anything. Who feeds it (telegram/watch.ts in the app)
// decides what a turn is; this file only draws one.

import type { TelegramApi } from './TelegramApi.js';
import { toTelegram, splitFormatted, truncateFormatted, type Formatted } from './entities.js';
import { collectDeliverables, extractMedia, type Deliverable } from './mediaTags.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('telegram');

/** Where a reply's files come from: a container path (`/workspace/X`) to a
 *  key for the real file inside the workspace on its host, null for anything
 *  else; and the file's bytes by that key. Code-mode turns only (a session
 *  has a work dir); absent = the reply delivers no files. */
export interface Delivery {
  locate(containerPath: string): Promise<string | null>;
  read(key: string): Promise<Buffer>;
}

export interface ReplyBubbleOptions {
  delivery?: Delivery;
  /** The answer arrives as a voice note (the caller's job): progress draws,
   *  the text does not — typing it out only to have it read aloud is twice. */
  voiceOnly?: boolean;
  /** Start without the dots — a one-shot message with nothing to wait for. */
  placeholder?: boolean;
  /** How often the bubble is drawn; Telegram's edit ceiling in production. */
  tickMs?: number;
}

const TOOL_EMOJI: Record<string, string> = {
  bash: '⚙️', read: '📖', write: '✍️', edit: '✏️', grep: '🔎', find: '🔎', ls: '📂',
  secret_get: '🔑', secret_list: '🔑', web_search: '🌐', web_fetch: '🌐',
  send_message: '📨', kanban_card_read: '📋', skill_load: '📚',
};
const DOTS = ['...', '....', '.....', '......'];
const THINKING = DOTS.map((dots) => `💭 thinking ${dots}`);
const THINKING_DONE = '💭 thinking ✓';
/** What a text block says while its text cleans down to nothing. */
const EMPTY = '…';
const TICK_MS = 1_000;
/** The elapsed counter on a tool line steps this often. */
const TOOL_STEP_S = 3;
const LIMIT = 4096;

/** The chat message a block is drawn in: its id once posted, what it says there. */
interface Message { id: number | null; shown: string }
const fresh = (): Message => ({ id: null, shown: '' });

type Block =
  | { type: 'waiting'; thinking: boolean; done: boolean; message: Message }
  | { type: 'text'; text: string; message: Message }
  | { type: 'tool'; id: string | null; name: string; since: number; done: boolean; message: Message };

export class ReplyBubble {
  readonly #api: TelegramApi;
  readonly #chatId: number;
  readonly #delivery?: Delivery;
  readonly #voiceOnly: boolean;
  #blocks: Block[] = [];
  #frame = 0;
  #timer: ReturnType<typeof setInterval> | null;
  #drawing: Promise<void> = Promise.resolve();
  #busy = false;
  #closed = false;

  constructor(api: TelegramApi, chatId: number, opts: ReplyBubbleOptions = {}) {
    this.#api = api;
    this.#chatId = chatId;
    this.#delivery = opts.delivery;
    this.#voiceOnly = opts.voiceOnly === true;
    if (opts.placeholder !== false) this.#blocks.push({ type: 'waiting', thinking: false, done: false, message: fresh() });
    this.#timer = setInterval(() => void this.#draw(), opts.tickMs ?? TICK_MS);
    void this.#draw();                   // the dots go up at once
  }

  /** One AI SDK stream part (the feed's `part.part`). */
  part(part: Record<string, unknown>): void {
    if (this.#closed) return;
    const last = this.#blocks[this.#blocks.length - 1];
    if (part.type === 'text-delta' && typeof part.text === 'string') {
      if (this.#voiceOnly) return;
      if (last?.type === 'text') last.text += part.text;
      else this.#begin({ type: 'text', text: part.text, message: fresh() });
    } else if (part.type === 'tool-input-start' || part.type === 'tool-call') {
      // One call arrives as two parts — tool-input-start while the arguments
      // stream (its id is `id`), tool-call once complete (`toolCallId`; a
      // provider that does not stream input sends only the second).
      const id = typeof part.toolCallId === 'string' ? part.toolCallId : typeof part.id === 'string' ? part.id : null;
      if (id != null && this.#blocks.some((block) => block.type === 'tool' && block.id === id)) return;
      const name = typeof part.toolName === 'string' ? part.toolName : 'tool';
      this.#begin({ type: 'tool', id, name, since: Date.now(), done: false, message: fresh() });
    } else if (part.type === 'tool-result') {
      const id = typeof part.toolCallId === 'string' ? part.toolCallId : null;
      const tool = this.#blocks.find((block) => block.type === 'tool' && !block.done && (id == null || block.id === id))
        ?? (last?.type === 'tool' && !last.done ? last : undefined);
      if (!tool || tool.type !== 'tool') return;
      tool.done = true;
      // Done, thinking about the result now.
      if (last === tool) this.#blocks.push({ type: 'waiting', thinking: true, done: false, message: fresh() });
    }
  }

  /** A new block begins: the dots hand over their message, a thinking line
   *  is closed, and the block joins the end. */
  #begin(block: Block): void {
    const last = this.#blocks[this.#blocks.length - 1];
    if (last?.type === 'waiting') {
      if (last.thinking) last.done = true;
      else { this.#blocks.pop(); block.message = last.message; }
    }
    this.#blocks.push(block);
  }

  /** The reply is complete: the final text, formatted and chunked, replaces
   *  the last text or waiting block; the files it named follow. Answers the
   *  text as sent (files cut out) — what to speak. */
  async finish(finalText: string): Promise<string> {
    await this.#stop();
    let final = finalText.trim();
    let files: Deliverable[] = [];
    if (this.#delivery && final) {
      const delivery = this.#delivery;
      const got = await collectDeliverables(final, (containerPath) => delivery.locate(containerPath));
      final = got.cleaned.trim();
      files = got.files;
    }
    // The slot the reply lands in: a wait at the end, or the text segment the
    // reply was streaming into. A wait with no reply to fill it is deleted; a
    // text segment stays as streamed.
    const last = this.#blocks[this.#blocks.length - 1];
    const slot = last?.type === 'waiting' || (last?.type === 'text' && final && !this.#voiceOnly) ? this.#blocks.pop()!.message : null;
    await this.#drawNow();               // tool lines and a closed thinking line settle first
    if (this.#voiceOnly || !final) {
      if (slot?.id != null) await this.#api.deleteMessage(this.#chatId, slot.id).catch((error: unknown) => this.#failed('delete', error));
    } else {
      const chunks = splitFormatted(toTelegram(final), LIMIT);
      try {
        // A streamed segment that already says the whole reply is left alone:
        // Telegram refuses an edit that changes nothing.
        if (slot?.id != null) { if (slot.shown !== chunks[0].text) await this.#api.editMessageText(this.#chatId, slot.id, chunks[0].text, chunks[0].entities); }
        else await this.#api.sendMessage(this.#chatId, chunks[0].text, { entities: chunks[0].entities });
        for (const chunk of chunks.slice(1)) await this.#api.sendMessage(this.#chatId, chunk.text, { entities: chunk.entities });
      } catch (error) { this.#failed('post the reply', error); }
    }
    // Files after the words, so the message explaining them arrives first. A
    // failure is said — "here's your report" with no report is the worst outcome.
    for (const file of files) {
      try {
        const name = file.path.slice(file.path.lastIndexOf('/') + 1);
        await this.#api.sendBytes(file.type, this.#chatId, await this.#delivery!.read(file.path), name);
      } catch (error) {
        await this.#api.sendMessage(this.#chatId, `⚠️ Couldn't send that file — ${errStr(error)}`).catch(() => undefined);
      }
    }
    return final;
  }

  /** Take the bubble down: a wait that never became anything is deleted;
   *  what was drawn stays. For a turn that threw, and for a wait the caller
   *  filled some other way (a voice note). Never throws. */
  async discard(): Promise<void> {
    await this.#stop();
    const last = this.#blocks[this.#blocks.length - 1];
    if (last?.type === 'waiting' && last.message.id != null) {
      await this.#api.deleteMessage(this.#chatId, last.message.id).catch((error: unknown) => this.#failed('delete', error));
    }
  }

  async #stop(): Promise<void> {
    this.#closed = true;
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
    await this.#drawing;
  }

  /** One tick. A tick that finds the last draw still in flight is skipped. */
  #draw(): Promise<void> {
    if (this.#busy) return this.#drawing;
    this.#busy = true;
    this.#frame = (this.#frame + 1) % DOTS.length;
    this.#drawing = this.#drawNow().finally(() => { this.#busy = false; });
    return this.#drawing;
  }

  /** Bring every message up to date with its block, in order. */
  async #drawNow(): Promise<void> {
    for (const block of this.#blocks) {
      const want = this.#textOf(block);
      if (want.text === block.message.shown) continue;
      try {
        if (block.message.id == null) {
          const sent = await this.#api.sendMessage(this.#chatId, want.text, { entities: want.entities });
          block.message.id = sent?.message_id ?? null;
        } else {
          await this.#api.editMessageText(this.#chatId, block.message.id, want.text, want.entities);
        }
        block.message.shown = want.text;
      } catch (error) { this.#failed(block.message.id == null ? 'send' : 'edit', error); }
    }
  }

  #textOf(block: Block): Formatted {
    switch (block.type) {
      case 'waiting':
        if (!block.thinking) return { text: DOTS[this.#frame], entities: [] };
        return { text: block.done ? THINKING_DONE : THINKING[this.#frame], entities: [] };
      case 'tool': {
        const emoji = TOOL_EMOJI[block.name] ?? '🔧';
        if (block.done) return { text: `${emoji} ${block.name} ✓`, entities: [] };
        const seconds = Math.floor((Date.now() - block.since) / 1000);
        return { text: `${emoji} ${block.name} · ${seconds - (seconds % TOOL_STEP_S)}s`, entities: [] };
      }
      case 'text': {
        // MEDIA: tags are cut as they stream (delivery turns only) so the user
        // never watches a path get typed out and vanish; bare paths read as
        // prose and are left for the final pass.
        const shown = this.#delivery ? extractMedia(block.text).cleaned : block.text;
        const formatted = truncateFormatted(toTelegram(shown), LIMIT);
        return formatted.text ? formatted : { text: EMPTY, entities: [] };
      }
    }
  }

  #failed(what: string, error: unknown): void {
    log.warn({ chat: this.#chatId, err: errStr(error) }, `reply bubble: could not ${what}`);
  }
}
