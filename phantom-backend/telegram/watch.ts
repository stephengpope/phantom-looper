// A chat WATCHES the session it is on — the one feed subscription that turns
// every part of every turn there into Telegram bubbles, whoever drives the
// turn: this bot's own agent, a cli window, a client runner, a cron. The bot
// drives its own turns and renders nothing itself; its agent's parts come
// back through this same subscription (the session bus carries a client its
// own events in-process), so there is one path from a turn to the chat.
//
// What streams is the chat's /stream setting, read at each turn's start:
//   on   every turn's reply (the default)
//   all  the same, plus a message typed elsewhere, shown above its reply
//   off  only this bot's own turns — the chat as it was before watching
//
// One bubble per turn: opened at turn-start (or at the first part, when the
// chat joined mid-turn), fed every part, closed at turn-end with the text it
// streamed, spoken when the reply mode says so. A turn that fails elsewhere
// is said once; this bot's own failures are its own to tell (the turn
// methods do). Events arrive in order and are handled in order.
//
// THE RECORD IS THE FALLBACK. A driver's stream is best effort: it can die
// mid-turn (the cli's relay stops at its first failed post) and the parts and
// the turn-end never come. The hold's release always does — turn-ended is
// retried until it lands — so a bubble still open when the hold lets go is
// finished from the record: the reply is the last assistant text there.
import type { PhantomBackend, SessionEvent, TelegramApi, ReplyBubble } from '@phantom-agent-sdk/backend';
import { logger, errStr } from '@phantom-agent-sdk/backend';
import { parseLines, conversationFrom } from '@phantom-agent-sdk/client/transcript';
import { CLIENT_ID } from './assistant.js';

const log = logger('telegram-watch');

export type TelegramStream = 'on' | 'all' | 'off';
export const STREAM_MODES: readonly TelegramStream[] = ['on', 'all', 'off'];

export class SessionWatch {
  #off: (() => void) | null = null;
  #chain: Promise<void> = Promise.resolve();
  #bubble: ReplyBubble | null = null;
  #typing: ReturnType<typeof startTyping> | null = null;
  #text = '';
  /** The turn in progress is nobody's business here (stream off, not ours). */
  #ignoring = false;
  /** The record moved during a turn this watch has not closed: a reply is
   *  owed to the chat when the hold lets go, whatever the stream delivered. */
  #owed = false;

  constructor(
    private readonly backend: PhantomBackend,
    private readonly api: TelegramApi,
    readonly chatId: number,
    readonly sessionId: string,
    private readonly stream: () => Promise<TelegramStream>,
  ) {}

  start(): void {
    if (this.#off) return;
    this.#off = this.backend.sessionEvents.subscribe(this.sessionId, (event, by) => {
      this.#chain = this.#chain.then(() => this.#on(event, by)).catch((error) => log.warn({ chat: this.chatId, session: this.sessionId, err: errStr(error) }, 'watch failed on an event'));
    });
    log.info({ chat: this.chatId, session: this.sessionId }, 'chat watches session');
  }

  /** Stop watching; a bubble left open is taken down. */
  async stop(): Promise<void> {
    this.#off?.();
    this.#off = null;
    await this.#chain.catch(() => undefined);
    await this.#close(null);
  }

  async #on(event: SessionEvent, by: string): Promise<void> {
    const own = by === CLIENT_ID;
    if (event.event === 'turn-start' || event.event === 'turn-end' || event.event === 'error' || (event.event === 'lock' && !event.locked)) {
      log.info({ chat: this.chatId, session: this.sessionId, event: event.event, by, bubble: this.#bubble !== null }, 'watch event');
    }
    switch (event.event) {
      case 'turn-start': {
        const mode = await this.stream();
        this.#ignoring = !own && mode === 'off';
        if (this.#ignoring) return;
        if (!own && mode === 'all' && event.message) {
          const session = await this.backend.sessions.get(this.sessionId);
          const from = session?.lockedLabel ?? 'elsewhere';
          const text = event.message.length > 1000 ? `${event.message.slice(0, 1000)}…` : event.message;
          await this.api.sendMessage(this.chatId, `💬 from ${from}: ${text}`).catch(() => undefined);
        }
        await this.#open();
        return;
      }
      case 'part': {
        if (this.#ignoring) return;
        if (!this.#bubble) {
          // Joined mid-turn: the turn is on, whoever's it is.
          if (!own && await this.stream() === 'off') { this.#ignoring = true; return; }
          await this.#open();
        }
        const part = event.part as { type?: string; text?: string };
        if (part.type === 'text-delta' && typeof part.text === 'string') this.#text += part.text;
        this.#bubble!.part(event.part);
        return;
      }
      case 'transcript': {
        if (!this.#ignoring) this.#owed = true;
        return;
      }
      case 'turn-end': {
        this.#ignoring = false;
        this.#owed = false;
        if (!this.#bubble) return;
        const bubble = this.#bubble;
        const typing = this.#typing;
        const text = this.#text;
        this.#bubble = null; this.#typing = null; this.#text = '';
        const said = await bubble.finish(text);
        log.info({ chat: this.chatId, session: this.sessionId, chars: said.length }, 'watch: reply posted');
        await this.backend.telegramBot.speakText(this.api, this.chatId, said, typing ?? undefined);
        typing?.stop();
        return;
      }
      case 'error': {
        // This bot's own turn tells the chat itself; another driver's failure is said here.
        const was = this.#bubble !== null;
        await this.#close(null);
        this.#ignoring = false;
        if (!own && was) await this.api.sendMessage(this.chatId, `⚠️ ${event.message}`).catch(() => undefined);
        return;
      }
      case 'lock': {
        // The hold let go with the turn not closed here — a bubble still
        // open, or a turn whose stream never arrived at all: the stream died.
        // The record has the reply.
        if (!event.locked && (this.#bubble || this.#owed)) await this.#finishFromRecord();
        if (!event.locked) { this.#owed = false; this.#ignoring = false; }
        return;
      }
      default: return;
    }
  }

  /** Close the turn with what the record says it answered — into the open
   *  bubble, or a fresh one when the stream never opened any. */
  async #finishFromRecord(): Promise<void> {
    if (!this.#bubble) await this.#open();
    const bubble = this.#bubble;
    const typing = this.#typing;
    this.#bubble = null; this.#typing = null; this.#text = ''; this.#owed = false;
    let reply = '';
    try {
      const messages = conversationFrom(parseLines(await this.backend.sessions.transcript(this.sessionId) ?? ''));
      const last = [...messages].reverse().find((message) => message.role === 'assistant');
      if (last) reply = typeof last.content === 'string' ? last.content
        : last.content.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('');
    } catch (error) { log.warn({ chat: this.chatId, session: this.sessionId, err: errStr(error) }, 'watch: could not read the record'); }
    log.info({ chat: this.chatId, session: this.sessionId, chars: reply.length }, 'watch: stream ended early — finishing from the record');
    if (!bubble) return;
    const said = await bubble.finish(reply);
    if (said) await this.backend.telegramBot.speakText(this.api, this.chatId, said, typing ?? undefined);
    typing?.stop();
  }

  async #open(): Promise<void> {
    if (this.#bubble) return;
    this.#text = '';
    this.#typing = startTyping(this.api, this.chatId);
    this.#bubble = await this.backend.telegramBot.startReplyBubble(this.api, this.chatId, this.sessionId);
  }

  async #close(_reason: null): Promise<void> {
    const bubble = this.#bubble;
    this.#bubble = null;
    this.#text = '';
    this.#typing?.stop();
    this.#typing = null;
    await bubble?.discard().catch(() => undefined);
  }
}

const TYPING_MS = 4000;
/** Keep an action showing for the whole turn, and let the caller change WHICH
 *  one. Telegram expires an action after ~5s, so it has to be re-sent on a
 *  timer — a one-off `record_voice` from elsewhere would be overwritten by the
 *  next `typing` tick. The switch belongs to the loop. */
export function startTyping(client: TelegramApi, chatId: number, initial = 'typing') {
  let action = initial;
  const ping = () => { client.sendChatAction(chatId, action).catch(() => {}); };
  ping();
  const timer = setInterval(ping, TYPING_MS);
  return {
    /** Show something else from now on, immediately and on every later tick. */
    set(next: string) { action = next; ping(); },
    stop() { clearInterval(timer); },
  };
}
