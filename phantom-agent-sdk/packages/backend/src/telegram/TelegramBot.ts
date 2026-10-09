// TelegramBot — everything that lets an app talk to a person on Telegram,
// up to "here is a verified message from you" and from "here is the reply"
// onward. The link (webhook, secret, menu), inbound verification and
// de-duplication, album grouping, which session a bubble belongs to, the
// approval gate, voice in and out, attachments into a session's files, and
// delivery — a streamed reply bubble, a message tied to a session. What to
// DO with a message — modes, commands, which turn to run — is the app's: it
// hangs off onMessageReceived / onReactionReceived / onButtonTapped.
//
// One bot per server, any number of linked chats (telegram/chats.ts): the
// operator's own (`telegram_authorized_user`, the cli's), and each user's —
// their private chat, or a group for one project — linked by a one-time
// code (/start <code>). A chat speaks for its user, and only the Telegram
// account that linked it may speak in it. The webhook URL is never a
// setting — always https + the public address.
import { TELEGRAM_WEBHOOK_PATH } from './webhookPath.js';
import crypto from 'node:crypto';
import { TelegramApi, ALLOWED_UPDATES } from './TelegramApi.js';
import { makeTelegramSink, type DeliverConfig, type TelegramSink } from './sink.js';
import { startWaitingBubble } from './bubble.js';
import { transcribeVoice, speakVoice, splitForSpeech, SPEAK_MAX_CHARS, type Transcription } from './TelegramVoice.js';
import { writeAttachment, composeMessage, MAX_INBOUND_BYTES, type StoredAttachment } from './TelegramAttachments.js';
import { Approvals, type Ask } from './TelegramApprovals.js';
import type { TelegramBotState } from './botState.js';
import type { TelegramSentMessages } from './sentMessages.js';
import type { TelegramHandledUpdates } from './handledUpdates.js';
import { operatorLink, type ChatLink, type TelegramChats } from './chats.js';
import type { Sessions } from '../storage/Sessions.js';
import type { Projects } from '../storage/Projects.js';
import { OPERATOR_ORGANIZATION } from '../lib/scopes.js';
import type { Settings } from '../storage/Settings.js';
import type { SettingsEvents } from '../agents/SettingsEvents.js';
import { timingSafeEqualStr } from '../lib/crypto.js';
import type { SessionHosts } from '../host/SessionHosts.js';
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
    const value = msg?.[field];
    if (!value) continue;
    out.push({ file: Array.isArray(value) ? value[value.length - 1] : value, kind });
  }
  return out;
}
function hasEmoji(list: any, emoji: string): boolean {
  return Array.isArray(list) && list.some((reaction) => reaction?.type === 'emoji' && reaction?.emoji === emoji);
}

export interface TelegramBotDeps {
  settings: Settings;
  settingsEvents?: SettingsEvents;
  botState: TelegramBotState;
  sentMessages: TelegramSentMessages;
  handledUpdates: TelegramHandledUpdates;
  /** The linked chats, and what a session's message needs to find its chat. */
  chats: TelegramChats;
  sessions: Sessions;
  projects: Projects;
  /** Where each session's files are (host/SessionHosts.ts). */
  hosts: SessionHosts;
  /** https://BACKEND_ADDRESS — the only source of the webhook URL. */
  publicAddress?: string;
  /** The command menu to register with Telegram (the app's commands): the
   *  global default, and the operator's chat's for its current mode. */
  commandMenu?: () => Promise<{ global: TelegramCommand[]; forChat?: TelegramCommand[] }>;
}
export interface TelegramCommand { command: string; description: string }

/** What the webhook registration looks like right now. */
export interface WebhookStatus { registered: boolean; url: string | null; botUsername: string | null }

/** A message from a linked chat's own sender, verified and de-duplicated; an album
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
  /** Tear the reply down after a turn that threw; resolves when the bubble is cleaned up. */
  discard(): Promise<void>;
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
    return `https://${host}/api${TELEGRAM_WEBHOOK_PATH}`;
  }

  async token(): Promise<string> {
    return (await this.deps.settings.credential('telegram_bot_token')) ?? '';
  }

  /** Who a chat speaks for: the operator's (the setting), a user's linked
   *  chat, or null — not linked, so the bot does not answer it. */
  async linkFor(chatId: number): Promise<ChatLink | null> {
    const operator = await this.authorizedUser();
    if (operator !== null && chatId === operator) return operatorLink(operator);
    return this.deps.chats.byChat(chatId);
  }

  /** The chat a session's messages go to: the operator's for the operator's
   *  own work; otherwise the owner's chat for the session's project, else
   *  the owner's private chat. Null: nowhere linked. */
  async chatForSession(sessionId: string): Promise<number | null> {
    const session = await this.deps.sessions.get(sessionId);
    const project = session ? await this.deps.projects.get(session.projectId) : undefined;
    if (!session || !project) return null;
    if (project.organizationId === OPERATOR_ORGANIZATION) return this.authorizedUser();
    return (await this.deps.chats.forOwner(project.organizationId, session.userId, project.id))?.chatId ?? null;
  }

  /** The operator's own chat (the setting), or null when none is set. */
  async authorizedUser(): Promise<number | null> {
    const chatId = Number(await this.deps.settings.resolve('telegram_authorized_user') ?? '');
    return Number.isFinite(chatId) && chatId ? chatId : null;
  }

  async isAuthorizedUser(userId: unknown): Promise<boolean> {
    const chatId = await this.authorizedUser();
    return chatId !== null && String(userId) === String(chatId);
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
    const whoami = await api.getMe().catch((error: Error) => { log.warn({ err: error.message }, 'getMe failed — the bot has no name this boot'); return null; });
    const secret = bot.webhookSecret ?? crypto.randomBytes(32).toString('hex');
    const info = await api.getWebhookInfo().catch((error: Error) => { log.warn({ err: error.message }, 'getWebhookInfo failed — re-registering'); return null; });
    const registered = info?.url === url
      && ALLOWED_UPDATES.every((update) => (info?.allowed_updates ?? []).includes(update));
    if (!registered || bot.webhookSecret !== secret) {
      await api.setWebhook(url, secret, { dropPending: false });
      await this.deps.botState.saveRegistration(secret, url, whoami?.username ?? null);
      log.info({ url }, 'telegram webhook registered');
    }
    // The menu lives in code, so a bot connected before a command existed
    // still gets it; set on every boot so a restart never leaves a stale one.
    const menu = await this.deps.commandMenu?.();
    if (menu) {
      await api.setMyCommands(menu.global).catch(() => {});
      const chatId = await this.authorizedUser();
      if (chatId && menu.forChat) await api.setMyCommands(menu.forChat, chatId).catch(() => {});
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
    } catch (error) {
      log.warn({ err: errStr(error) }, 'telegram reconcile failed');
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
        (error) => log.warn({ err: errStr(error) }, 'sent message not recorded')); },
      (id) => { this.deps.sentMessages.delete(chatId, id).catch(
        (error) => log.warn({ err: errStr(error) }, 'sent message not forgotten')); });
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
    /** The chat's link, when the sender is the account that linked it. */
    const speaker = async (chatId: unknown, from: unknown): Promise<ChatLink | null> => {
      const link = Number.isFinite(Number(chatId)) ? await this.linkFor(Number(chatId)) : null;
      return link && String(from) === String(link.telegramUserId) ? link : null;
    };

    const reaction = update.message_reaction;
    if (reaction) {
      const link = await speaker(reaction.chat?.id, reaction.user?.id);
      if (!link) return 200;
      if (!(await this.deps.handledUpdates.markHandled(update.update_id))) return 200;
      // 🤬 on a bubble: read it back aloud. The bot's own gesture; the app hears the rest.
      if (hasEmoji(reaction.new_reaction, REACT_SPEAK) && !hasEmoji(reaction.old_reaction, REACT_SPEAK)) {
        this.speakRepliedMessage(reaction, link.chatId).catch((error) => log.warn({ err: errStr(error) }, 'speak-reacted failed'));
      } else {
        this.#onReaction?.(link.chatId, reaction).catch((error) => log.warn({ err: errStr(error) }, 'reaction handler failed'));
      }
      return 200;
    }

    const tap = update.callback_query;
    if (tap) {
      const link = await speaker(tap.message?.chat?.id, tap.from?.id);
      if (!link) return 200;
      if (!(await this.deps.handledUpdates.markHandled(update.update_id))) return 200;
      const api = new TelegramApi(await this.token());
      const query = { id: String(tap.id), data: tap.data as string | undefined };
      if (Approvals.isApprovalCallback(query.data)) {
        this.#approvals.handleCallback(api, link.chatId, query).catch((error) => log.warn({ err: errStr(error) }, 'approval tap failed'));
      } else {
        this.#onButton?.(link.chatId, query, api).catch((error) => log.warn({ err: errStr(error) }, 'button handler failed'));
      }
      return 200;
    }

    const msg = update.message;
    if (!msg?.chat?.id) return 200;
    // A link being made: /start <code> (a private chat), /start@bot <code> (a group).
    const linking = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{8,64})\s*$/.exec(String(msg.text ?? ''));
    if (linking) {
      if (!(await this.deps.handledUpdates.markHandled(update.update_id))) return 200;
      await this.link(Number(msg.chat.id), Number(msg.from?.id), linking[1]).catch((error) => log.warn({ err: errStr(error) }, 'telegram link failed'));
      return 200;
    }
    const link = await speaker(msg.chat.id, msg.from?.id);
    if (!link) return 200;
    if (!(await this.deps.handledUpdates.markHandled(update.update_id))) return 200;
    const chatId = link.chatId;

    // An album (several photos sent at once) arrives as SEPARATE updates
    // sharing a media_group_id. Collect them briefly and hand over once, so
    // the app sees all photos together instead of each as its own task.
    const groupId = msg.media_group_id ? String(msg.media_group_id) : null;
    const deliver = (msgs: any[]) => this.#onMessage?.(chatId, msgs).catch((error) => log.error({ err: errStr(error) }, 'telegram message handler failed'));
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

  /** Redeem a link code from a chat; the chat is told how it went. */
  private async link(chatId: number, telegramUserId: number, code: string): Promise<void> {
    const api = new TelegramApi(await this.token());
    const linked = await this.deps.chats.redeem(code, chatId, telegramUserId);
    if (!linked) { await api.sendMessage(chatId, '⚠️ That link has expired or was already used — make a new one in the app.'); return; }
    const project = linked.projectId ? await this.deps.projects.get(linked.projectId) : undefined;
    await api.sendMessage(chatId, project
      ? `✅ Linked to ${project.displayName ?? project.name}. Send a message to begin.`
      : '✅ Linked. Send a message to begin.');
    log.info({ chat: chatId, project: linked.projectId }, 'telegram chat linked');
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
      .catch(async (error) => { await react(); throw error; });
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
    const scratch = (await this.deps.hosts.of(sessionId)).files(sessionId);
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

  /** File delivery for a session's reply: the agent's /workspace/... paths
   *  located on the workspace's host, confined to the workspace (a link
   *  pointing out is not a file), read from there. */
  deliveryFor(sessionId: string): DeliverConfig {
    const files = async () => (await this.deps.hosts.of(sessionId)).files(sessionId);
    return {
      locate: async (containerPath) => {
        if (!containerPath.startsWith('/workspace/')) return null;
        const rel = containerPath.slice('/workspace/'.length);
        return (await (await files()).realFile(rel)) ? rel : null;
      },
      read: async (rel) => (await (await files()).read(rel)) ?? Buffer.alloc(0),
    };
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
    const chatId = await this.chatForSession(sessionId);
    if (!chatId) throw new Error('no Telegram chat is linked for this session\'s owner');
    const token = await this.token();
    if (!token) throw new Error('no telegram_bot_token stored (/keys)');
    const api = this.clientForChat(token, chatId, () => sessionId);
    const bubble = await this.startReplyBubble(api, chatId, sessionId, { bubble: false });
    const said = await bubble.finish(text);
    await this.speakText(api, chatId, said);
  }

  /** A plain message to one chat, not a session's (the digest, an alert). */
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
  private async speakRepliedMessage(reaction: any, authorizedChatId: number): Promise<void> {
    const chatId = Number(reaction.chat?.id);
    const messageId = Number(reaction.message_id);
    if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) return;
    const stored = await this.deps.sentMessages.get(chatId, messageId);
    if (!stored) return;
    const api = new TelegramApi(await this.token());
    const apiKey = (await this.deps.settings.credential('deepgram_api_key')) ?? '';
    const voice = String(await this.deps.settings.resolve('voice_spoken_voice'));
    api.sendChatAction(authorizedChatId, 'record_voice').catch(() => {});
    const audio = await speakVoice(apiKey, voice, stored.content.replace(/\n\n\(\d+\/\d+\)$/, '').slice(0, SPEAK_MAX_CHARS));
    if (audio) await api.sendVoiceBytes(chatId, audio, { replyToMessageId: messageId }).catch(() => {});
    else await api.sendMessage(chatId, "⚠️ I couldn't turn that into audio — check the Deepgram key.", { replyToMessageId: messageId }).catch(() => {});
  }
}
