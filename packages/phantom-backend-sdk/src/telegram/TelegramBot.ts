// TelegramBot — everything that lets an app talk to a person on Telegram,
// up to "here is a verified message from you" and from "here is the reply"
// onward. The link (webhook, secret, menu), inbound verification and
// de-duplication, album grouping, which session a bubble belongs to, the
// approval gate, voice in and out, attachments into a session's files, and
// delivery — a streamed reply bubble, a message tied to a session. What to
// DO with a message — modes, commands, which turn to run — is the app's: it
// hangs off onMessageReceived / onReactionReceived / onButtonTapped.
//
// The bot talks to ONE person: `telegram_authorized_user`. The webhook URL
// is never a setting — always https + the public address.
import crypto from 'node:crypto';
import path from 'node:path';
import { TelegramApi, ALLOWED_UPDATES } from './TelegramApi.js';
import { makeTelegramSink, type DeliverConfig, type TelegramSink } from './sink.js';
import { startWaitingBubble } from './bubble.js';
import { transcribeVoice, speakVoice, splitForSpeech, SPEAK_MAX_CHARS, type Transcription } from './TelegramVoice.js';
import { writeAttachment, composeMessage, MAX_INBOUND_BYTES, type StoredAttachment } from './TelegramAttachments.js';
import { Approvals, type Ask } from './TelegramApprovals.js';
import type { TelegramBotState, TelegramBotStateRow } from './botState.js';
import type { TelegramSentMessages } from './sentMessages.js';
import type { TelegramHandledUpdates } from './handledUpdates.js';
import type { Settings } from '../storage/Settings.js';
import type { SettingsEvents } from '../agents/SettingsEvents.js';
import { timingSafeEqualStr } from '../lib/crypto.js';
import { sessionDir, type Paths } from '../lib/paths.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('telegram');

const REACT_TRANSCRIBING = '\u{270D}';   // ✍ writing hand, no U+FE0F — replaced by 👍 when heard
const REACT_HEARD = '\u{1F44D}';         // 👍 — transcription done
const REACT_SPEAK = '\u{1F92C}';         // 🤬 — the user's "read this back" gesture

// What the user reads when a voice note could not be heard, by reason.
const NOT_HEARD: Record<Extract<Transcription, { error: string }>['error'], string> = {
  no_key: '🎤 Voice transcription needs a Deepgram key — add one in /keys.',
  unreachable: "🎤 Couldn't reach Deepgram — send that again in a moment.",
  vendor: "🎤 Deepgram couldn't transcribe that — send it again.",
};

const MEDIA_FIELDS: Array<{ field: string; kind?: 'image' | 'video' | 'audio' }> = [
  { field: 'photo', kind: 'image' }, { field: 'document' },
  { field: 'video', kind: 'video' }, { field: 'video_note', kind: 'video' },
  { field: 'animation', kind: 'video' }, { field: 'audio', kind: 'audio' },
];
/** The file-bearing fields of a message, each resolved to its largest size. */
export function collectFiles(msg: any): Array<{ file: any; kind?: 'image' | 'video' | 'audio' }> {
  const out: Array<{ file: any; kind?: 'image' | 'video' | 'audio' }> = [];
  for (const { field, kind } of MEDIA_FIELDS) {
    const v = msg?.[field];
    if (!v) continue;
    out.push({ file: Array.isArray(v) ? v[v.length - 1] : v, kind });
  }
  return out;
}
function hasEmoji(list: any, emoji: string): boolean {
  return Array.isArray(list) && list.some((r) => r?.type === 'emoji' && r?.emoji === emoji);
}

export interface TelegramBotDeps {
  settings: Settings;
  settingsEvents?: SettingsEvents;
  botState: TelegramBotState;
  sentMessages: TelegramSentMessages;
  handledUpdates: TelegramHandledUpdates;
  paths: Paths;
  /** https://PHANTOM_BACKEND_ADDRESS — the only source of the webhook URL. */
  publicAddress?: string;
  /** The command menu to register with Telegram (the app's commands): the
   *  global default, and the authorized chat's for its current mode. */
  commandMenu?: (state: TelegramBotStateRow) => Promise<{ global: TelegramCommand[]; forChat?: TelegramCommand[] }>;
}
export interface TelegramCommand { command: string; description: string }

/** What the webhook registration looks like right now. */
export interface WebhookStatus { registered: boolean; url: string | null; botUsername: string | null }

/** A message from the authorized user, verified and de-duplicated; an album
 *  arrives as one call with every photo in `messages`. */
export type MessageHandler = (chatId: number, messages: any[]) => Promise<void>;
export type ReactionHandler = (chatId: number, reaction: any) => Promise<void>;
/** A button tap the bot did not answer itself (approvals are). */
export type ButtonHandler = (chatId: number, query: { id: string; data: string | undefined }, api: TelegramApi) => Promise<void>;

/** A reply streamed into one chat as it is written. */
export interface ReplyBubble {
  appendPart(part: Record<string, unknown>): void;
  /** The reply is complete; answers what was said (in voice mode the text was withheld, so it comes back here to be spoken). */
  finish(finalText: string): Promise<string>;
  discard(): void;
}

export class TelegramBot {
  readonly #approvals = new Approvals();
  readonly #albums = new Map<string, { msgs: any[]; timer: NodeJS.Timeout }>();
  #onMessage: MessageHandler | null = null;
  #onReaction: ReactionHandler | null = null;
  #onButton: ButtonHandler | null = null;

  constructor(private readonly deps: TelegramBotDeps) {
    deps.settingsEvents?.subscribe((change) => {
      if (change.keys.some((key) => key === 'telegram_enabled' || key === 'telegram_authorized_user' || key === 'telegram_bot_token')) void this.reconcileLink();
    });
  }

  // ── the link ──────────────────────────────────────────────────────────

  /** The webhook URL — never a setting: always https + the public address. */
  webhookUrl(): string | null {
    const addr = this.deps.publicAddress?.trim();
    if (!addr) return null;
    const host = addr.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `https://${host}/api/telegram/webhook`;
  }

  async token(): Promise<string> {
    return (await this.deps.settings.credential('telegram_bot_token')) ?? '';
  }

  /** The one chat the bot talks to, or null when none is set. */
  async authorizedUser(): Promise<number | null> {
    const dm = Number(await this.deps.settings.resolve('telegram_authorized_user') ?? '');
    return Number.isFinite(dm) && dm ? dm : null;
  }

  async isAuthorizedUser(userId: unknown): Promise<boolean> {
    const dm = await this.authorizedUser();
    return dm !== null && String(userId) === String(dm);
  }

  async webhookStatus(): Promise<WebhookStatus> {
    const bot = await this.deps.botState.read();
    return { registered: !!bot.webhookUrl, url: bot.webhookUrl ?? null, botUsername: bot.botUsername ?? null };
  }

  /** Register the webhook (minting a secret if needed) and push the command
   *  menu. Only re-registers when the URL or the subscription drifted
   *  (dropPending:false keeps queued messages). */
  async registerWebhook(): Promise<void> {
    const token = await this.token();
    const url = this.webhookUrl();
    if (!token || !url) return;
    const bot = await this.deps.botState.read();
    const api = new TelegramApi(token);
    const me = await api.getMe().catch((e: Error) => { log.warn({ err: e.message }, 'getMe failed — the bot has no name this boot'); return null; });
    const secret = bot.webhookSecret ?? crypto.randomBytes(32).toString('hex');
    const info = await api.getWebhookInfo().catch((e: Error) => { log.warn({ err: e.message }, 'getWebhookInfo failed — re-registering'); return null; });
    const registered = info?.url === url
      && ALLOWED_UPDATES.every((u) => (info?.allowed_updates ?? []).includes(u));
    if (!registered || bot.webhookSecret !== secret) {
      await api.setWebhook(url, secret, { dropPending: false });
      await this.deps.botState.saveRegistration(secret, url, me?.username ?? null);
      log.info({ url }, 'telegram webhook registered');
    }
    // The menu lives in code, so a bot connected before a command existed
    // still gets it; set on every boot so a restart never leaves a stale one.
    const menu = await this.deps.commandMenu?.(bot);
    if (menu) {
      await api.setMyCommands(menu.global).catch(() => {});
      const dm = await this.authorizedUser();
      if (dm && menu.forChat) await api.setMyCommands(menu.forChat, dm).catch(() => {});
    }
  }

  /** Tear the webhook down and forget the registration. */
  async unregisterWebhook(): Promise<void> {
    const bot = await this.deps.botState.read();
    if (!bot.webhookUrl) return;
    const token = await this.token();
    if (token) await new TelegramApi(token).deleteWebhook().catch(() => {});
    await this.deps.botState.clearRegistration();
  }

  /** The link as the settings say: enabled + token + address → registered;
   *  otherwise torn down. Run at boot and on every telegram setting write. */
  async reconcileLink(): Promise<void> {
    try {
      const enabled = await this.deps.settings.resolve('telegram_enabled') === true;
      const token = await this.token();
      const url = this.webhookUrl();
      if (!enabled || !token || !url) {
        const bot = await this.deps.botState.read();
        if (bot.webhookUrl) {
          await this.unregisterWebhook();
          log.info({ enabled, hasToken: !!token, hasUrl: !!url }, 'telegram disabled — webhook torn down');
        }
        return;
      }
      await this.registerWebhook();
    } catch (e) {
      log.warn({ err: errStr(e) }, 'telegram reconcile failed');
    }
  }

  /** Push a command menu: the global default, or one chat's. */
  async setCommandMenu(commands: TelegramCommand[], chatId?: number): Promise<void> {
    const api = new TelegramApi(await this.token());
    await api.setMyCommands(commands, chatId).catch(() => {});
  }

  // ── the client for a chat ─────────────────────────────────────────────

  /** A Bot API client that records every sent and deleted message against
   *  the session it belongs to, so a reply or reaction to a bubble can find
   *  its way back. `sessionId` is a function so it can track a pointer that
   *  moves mid-turn; null = not a session's. */
  clientForChat(token: string, chatId: number, sessionId: () => string | null): TelegramApi {
    return new TelegramApi(token,
      (id, text) => { this.deps.sentMessages.record(chatId, id, text, sessionId()).catch(
        (e) => log.warn({ err: errStr(e) }, 'sent message not recorded')); },
      (id) => { this.deps.sentMessages.delete(chatId, id).catch(
        (e) => log.warn({ err: errStr(e) }, 'sent message not forgotten')); });
  }

  // ── inbound ───────────────────────────────────────────────────────────

  onMessageReceived(handler: MessageHandler): void { this.#onMessage = handler; }
  onReactionReceived(handler: ReactionHandler): void { this.#onReaction = handler; }
  onButtonTapped(handler: ButtonHandler): void { this.#onButton = handler; }

  /** The webhook's body. Fast-ack, then run out-of-band. Answers the HTTP
   *  status: 200 for anything handled or ignored, 403 for a bad secret. A
   *  settings read that fails THROWS (the route answers 500 and Telegram
   *  retries) instead of the message being dropped as "disabled". */
  async receiveUpdate(secretHeader: string, update: any): Promise<number> {
    const bot = await this.deps.botState.read();
    if (await this.deps.settings.resolve('telegram_enabled') !== true) return 200;
    if (!bot.webhookSecret || !timingSafeEqualStr(secretHeader, bot.webhookSecret)) return 403;
    const dm = await this.authorizedUser();
    if (!dm) return 200;
    const authorized = String(dm);

    const reaction = update.message_reaction;
    if (reaction) {
      if (String(reaction.user?.id) !== authorized) return 200;
      if (!(await this.deps.handledUpdates.markHandled(update.update_id))) return 200;
      // 🤬 on a bubble: read it back aloud. The bot's own gesture; the app hears the rest.
      if (hasEmoji(reaction.new_reaction, REACT_SPEAK) && !hasEmoji(reaction.old_reaction, REACT_SPEAK)) {
        this.speakRepliedMessage(reaction, dm).catch((e) => log.warn({ err: errStr(e) }, 'speak-reacted failed'));
      } else {
        this.#onReaction?.(dm, reaction).catch((e) => log.warn({ err: errStr(e) }, 'reaction handler failed'));
      }
      return 200;
    }

    const tap = update.callback_query;
    if (tap) {
      if (String(tap.from?.id) !== authorized) return 200;
      if (!(await this.deps.handledUpdates.markHandled(update.update_id))) return 200;
      const api = new TelegramApi(await this.token());
      const query = { id: String(tap.id), data: tap.data as string | undefined };
      if (Approvals.isApprovalCallback(query.data)) {
        this.#approvals.handleCallback(api, dm, query).catch((e) => log.warn({ err: errStr(e) }, 'approval tap failed'));
      } else {
        this.#onButton?.(dm, query, api).catch((e) => log.warn({ err: errStr(e) }, 'button handler failed'));
      }
      return 200;
    }

    const msg = update.message;
    if (!msg || String(msg.from?.id) !== authorized) return 200;
    if (!(await this.deps.handledUpdates.markHandled(update.update_id))) return 200;

    // An album (several photos sent at once) arrives as SEPARATE updates
    // sharing a media_group_id. Collect them briefly and hand over once, so
    // the app sees all photos together instead of each as its own task.
    const groupId = msg.media_group_id ? String(msg.media_group_id) : null;
    const deliver = (msgs: any[]) => this.#onMessage?.(dm, msgs).catch((e) => log.error({ err: errStr(e) }, 'telegram message handler failed'));
    if (groupId) {
      const entry = this.#albums.get(groupId) ?? { msgs: [] as any[], timer: null as unknown as NodeJS.Timeout };
      entry.msgs.push(msg);
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => { this.#albums.delete(groupId); void deliver(entry.msgs); }, 800);
      this.#albums.set(groupId, entry);
      return 200;
    }
    void deliver([msg]);
    return 200;
  }

  /** The session a replied-to bubble belongs to: a session's id, null for a
   *  bubble that was not a session's (the assistant's), undefined when the
   *  message is not a reply to one of ours. */
  async sessionOfRepliedMessage(chatId: number, msg: any): Promise<string | null | undefined> {
    const replied = msg.reply_to_message;
    if (!replied?.message_id) return undefined;
    const stored = await this.deps.sentMessages.get(chatId, Number(replied.message_id));
    return stored ? stored.sessionId : undefined;
  }

  /** The last bubble this bot sent for a session in a chat — what a code-mode
   *  label quotes under the session's title. */
  async lastMessageForSession(chatId: number, sessionId: string): Promise<string | null> {
    const stored = await this.deps.sentMessages.lastForSession(chatId, sessionId).catch(() => null);
    return stored ?? null;
  }

  // ── approvals ─────────────────────────────────────────────────────────

  /** A gated tool asks the user yes/no and waits. */
  askForApproval(api: TelegramApi, chatId: number, ask: Ask, signal?: AbortSignal): Promise<boolean> {
    return this.#approvals.request(api, chatId, ask, signal);
  }
  /** A typed message while a question stands: the exact word answers it. True when it did. */
  answerApprovalByText(chatId: number, text: string): boolean { return this.#approvals.handleText(chatId, text); }

  // ── voice in, files in ────────────────────────────────────────────────

  /** Transcribe an inbound voice or video note: download, react, transcribe.
   *  The text, or null when it couldn't be heard (the user was told why). */
  async transcribeVoiceNote(api: TelegramApi, chatId: number, msg: any, file: { file_id: string; file_size?: number }): Promise<string | null> {
    const react = (emoji?: string) => api.setMessageReaction(chatId, msg.message_id, emoji).catch(() => {});
    if (file.file_size && file.file_size > MAX_INBOUND_BYTES) {
      await api.sendMessage(chatId, "⚠️ That voice note is over Telegram's 20 MB limit for bots.");
      return null;
    }
    const apiKey = await this.deps.settings.credential('deepgram_api_key');
    if (!apiKey) { await api.sendMessage(chatId, NOT_HEARD.no_key); return null; }
    const [, audio] = await Promise.all([react(REACT_TRANSCRIBING), api.downloadFile(file.file_id)])
      .catch(async (e) => { await react(); throw e; });
    const { voice_stt_model: sttModel, telegram_transcript_echo: echo } =
      await this.deps.settings.resolveMany(['voice_stt_model', 'telegram_transcript_echo']);
    const heard = await transcribeVoice(apiKey, audio, String(sttModel));
    if ('error' in heard) { await react(); await api.sendMessage(chatId, NOT_HEARD[heard.error]); return null; }
    if (!heard.text) { await react(); await api.sendMessage(chatId, "🎤 I couldn't make out any speech in that."); return null; }
    await react(REACT_HEARD);
    if (echo === true) await api.sendMessage(chatId, `🎤 "${heard.text}"`);
    return heard.text;
  }

  /** Save the files of these messages into the session's scratch pad, and
   *  answer the line the agent is told (the user's text with the files
   *  described). Null when nothing was stored. */
  async saveAttachmentsToSession(api: TelegramApi, chatId: number, msgs: any[], sessionId: string, typed: string): Promise<string | null> {
    const files = msgs.flatMap(collectFiles);
    if (!files.length) return null;
    const scratch = sessionDir(this.deps.paths, sessionId) + '/scratch';
    const stored: StoredAttachment[] = [];
    for (const { file, kind } of files) {
      if (file.file_size && file.file_size > MAX_INBOUND_BYTES) {
        await api.sendMessage(chatId, `⚠️ "${file.file_name ?? 'that file'}" is over Telegram's 20 MB limit.`);
        continue;
      }
      const a = await writeAttachment(scratch, await api.downloadFile(file.file_id),
        { filename: file.file_name, mimeType: file.mime_type, defaultKind: kind });
      if (a) stored.push(a);
    }
    if (!stored.length) return null;
    return composeMessage(stored, typed);
  }

  // ── outbound ──────────────────────────────────────────────────────────

  /** File delivery for a session's reply: map the agent's /workspace/...
   *  paths to host files under the session's work dir, and confine delivery there. */
  deliveryFor(sessionId: string): DeliverConfig {
    const root = sessionDir(this.deps.paths, sessionId);   // host view of /workspace
    return { roots: [root], toHost: (p) => p.startsWith('/workspace') ? path.join(root, p.slice('/workspace'.length)) : p };
  }

  /** The reply mode, read where a reply is about to be sent. */
  async voiceOnly(): Promise<boolean> {
    return String(await this.deps.settings.resolve('telegram_reply_mode')) === 'voice';
  }

  /** A reply bubble for one chat: a "…" placeholder, the text edited in
   *  place as it streams, files the agent named delivered at the end. */
  async startReplyBubble(api: TelegramApi, chatId: number, sessionId: string | null, options: { bubble?: boolean } = {}): Promise<ReplyBubble> {
    const sink: TelegramSink = makeTelegramSink(api, chatId, sessionId ? this.deliveryFor(sessionId) : undefined,
      { voiceOnly: await this.voiceOnly(), ...(options.bubble === false ? { bubble: false } : {}) });
    return { appendPart: (part) => sink.part(part), finish: (text) => sink.done(text), discard: () => sink.dispose() };
  }

  /** One deliberate message from a session (the send_message tool), through
   *  the same sink a reply takes so it arrives exactly as a reply would, and
   *  recorded against the session so a reply to it enters that session.
   *  Throws with the reason when the bot is off or unconfigured. */
  async sendMessageForSession(sessionId: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error('empty message');
    if (await this.deps.settings.resolve('telegram_enabled') !== true) throw new Error('telegram is off (/settings)');
    const dm = await this.authorizedUser();
    if (!dm) throw new Error('no telegram_authorized_user set (/settings)');
    const token = await this.token();
    if (!token) throw new Error('no telegram_bot_token stored (/keys)');
    const api = this.clientForChat(token, dm, () => sessionId);
    const bubble = await this.startReplyBubble(api, dm, sessionId, { bubble: false });
    const said = await bubble.finish(text);
    await this.speakText(api, dm, said);
  }

  /** A plain message to the authorized user, not a session's (the digest, an alert). */
  async sendText(chatId: number, text: string, options?: { replyToMessageId?: number }): Promise<void> {
    const api = new TelegramApi(await this.token());
    await api.sendMessage(chatId, text, options);
  }

  /** Speak the reply when the mode asks. Long replies are split so audio
   *  starts in under a second — two synthesis requests fly in parallel,
   *  sent in order, dots between pieces. In `voice` mode the sink withheld
   *  the text, so a failed synthesis falls back to sending it. `typing` is
   *  the turn's indicator loop, swapped to record_voice while synthesis runs. */
  async speakText(api: TelegramApi, chatId: number, text?: string, typing?: { set(a: string): void }): Promise<void> {
    const mode = String(await this.deps.settings.resolve('telegram_reply_mode'));
    if (mode !== 'voice' && mode !== 'both') return;
    const say = (text ?? '').trim();
    if (!say) return;
    const apiKey = await this.deps.settings.credential('deepgram_api_key');
    if (!apiKey) {
      if (mode === 'voice') await api.sendMarkdown(chatId, say).catch(() => {});
      return;
    }
    typing?.set('record_voice');
    const voice = String(await this.deps.settings.resolve('voice_spoken_voice'));
    const chunks = splitForSpeech(say);
    if (!chunks.length) return;
    if (chunks.length === 1) {
      const audio = await speakVoice(apiKey, voice, chunks[0]);
      if (audio) await api.sendVoiceBytes(chatId, audio).catch(() => {});
      else if (mode === 'voice') await api.sendMarkdown(chatId, say).catch(() => {});
      return;
    }
    const jobs: (Promise<Buffer | null> | undefined)[] = [];
    const startJob = (i: number) => {
      if (i >= chunks.length || jobs[i]) return;
      jobs[i] = speakVoice(apiKey, voice, chunks[i]);
    };
    startJob(0); startJob(1);
    let sent = 0;
    for (let i = 0; i < chunks.length; i++) {
      const bubble = i === 0 ? null : startWaitingBubble(api, chatId);
      try {
        const audio = await jobs[i]!;
        startJob(i + 2);
        if (!audio) break;
        await bubble?.remove();
        await api.sendVoiceBytes(chatId, audio);
        sent++;
      } catch {
        await bubble?.remove();
        break;
      }
    }
    if (!sent && mode === 'voice') await api.sendMarkdown(chatId, say).catch(() => {});
  }

  /** 🤬 on one of our bubbles: read it back as a voice note. */
  private async speakRepliedMessage(reaction: any, dm: number): Promise<void> {
    const chatId = Number(reaction.chat?.id);
    const messageId = Number(reaction.message_id);
    if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) return;
    const stored = await this.deps.sentMessages.get(chatId, messageId);
    if (!stored) return;
    const api = new TelegramApi(await this.token());
    const apiKey = (await this.deps.settings.credential('deepgram_api_key')) ?? '';
    const voice = String(await this.deps.settings.resolve('voice_spoken_voice'));
    api.sendChatAction(dm, 'record_voice').catch(() => {});
    const audio = await speakVoice(apiKey, voice, stored.content.replace(/\n\n\(\d+\/\d+\)$/, '').slice(0, SPEAK_MAX_CHARS));
    if (audio) await api.sendVoiceBytes(chatId, audio, { replyToMessageId: messageId }).catch(() => {});
    else await api.sendMessage(chatId, "⚠️ I couldn't turn that into audio — check the Deepgram key.", { replyToMessageId: messageId }).catch(() => {});
  }
}
