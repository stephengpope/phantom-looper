// The Telegram engine: the bot as a client of this server. Started after
// listen (like the looper), reaching the routes through injectFetch. One
// authorized user, DM-only, webhook (never polling). Two modes on one sticky
// account row: ASSISTANT (home — the Assistant answers, board/cards/sessions)
// and CODE (inside a session — a plain message runs a coding turn on it).
//
// Design is phantom-looper's, not shockwave's: sessions are explicit and
// long-lived (no lazy chat minting, no per-message checkout prep), the
// Assistant is the primary agent, work lands only through /autopush, and voice
// is Deepgram-only. Mechanisms (the streaming bubble, entities, telegram_sent,
// attachments, the escape-spelled reactions) are ported from ../shockwave.

import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ModelMessage } from 'ai';
import type { Db } from '../db/client.js';
import type { Paths } from '../pool/paths.js';
import { sessionDir } from '../pool/paths.js';
import { injectFetch } from '../looper/injectFetch.js';
import { runCodingTurn, settingsValues, type TurnDeps } from '../looper/turn.js';
import { openSession, SessionLockedError, type OpenedSession } from '../../core/session.js';
import { getSession } from '../sessions.js';
import { resolveCredential } from '../settings.js';
import type { SessionEvents } from '../api/sessionEvents.js';
import { logger, errStr } from '../log.js';
import { TelegramClient, ALLOWED_UPDATES } from './client.js';
import { makeTelegramSink, type DeliverConfig } from './sink.js';
import { sendMessageTool } from './sendMessageTool.js';
import { toTelegram, splitFormatted } from './entities.js';
import { transcribeVoice, speakVoice, SPEAK_MAX_CHARS, type Transcription } from './deepgram.js';
import { writeAttachment, composeMessage, MAX_INBOUND_BYTES, type StoredAttachment } from './attachments.js';
import { runAssistantTurn, type AssistantDeps } from './assistant.js';
import { Approvals } from './approvals.js';
import * as store from './store.js';
import { menuFor, handleCommand } from './commands.js';

const log = logger('telegram');
const BASE = 'http://looper';
const CLIENT_ID = 'telegram';

// Progress on a voice message itself. WRITTEN AS ESCAPES — Telegram's reaction
// set carries no variation selectors, and a picker-pasted glyph brings one,
// yielding REACTION_INVALID.
const REACT_TRANSCRIBING = '\u{270D}';   // ✍ writing hand, no U+FE0F — cleared when heard
const REACT_SPEAK = '\u{1F92C}';         // 🤬 — the user's "read this back" gesture

// What the user reads when a voice note could not be heard, by reason.
const NOT_HEARD: Record<Extract<Transcription, { error: string }>['error'], string> = {
  no_key: '🎤 Voice transcription needs a Deepgram key — add one in /keys.',
  unreachable: "🎤 Couldn't reach Deepgram — send that again in a moment.",
  vendor: "🎤 Deepgram couldn't transcribe that — send it again.",
};

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export interface TelegramEngineDeps {
  db: Db;
  paths: Paths;
  app: FastifyInstance;
  apiKey: string;
  encryptionKey: Buffer;
  sessionEvents?: SessionEvents;
  modelFetch?: typeof fetch;
  /** https://PHANTOM_BACKEND_ADDRESS — the only source of the webhook URL. */
  publicAddress?: string;
}

/** A turn in flight on THIS server, by chat. A second message while busy is
 *  queued and sent as one follow-up turn (the cli's queue shape); it never
 *  starts a second turn. The AbortController is what /stop reaches. */
interface Busy { queue: string[]; abort: AbortController }

export class TelegramEngine {
  private f: typeof fetch;
  private busy = new Map<number, Busy>();
  /** The Assistant's ONE in-memory conversation (reset on restart). */
  private assistantHistory: ModelMessage[] = [];
  /** The approval gate — gated tools ask the user here (approvals.ts). */
  private approvals = new Approvals();

  constructor(private deps: TelegramEngineDeps) {
    this.f = injectFetch(deps.app);
  }

  // ── setup ─────────────────────────────────────────────────────────────

  /** The webhook URL — never a setting: always https + the public address. */
  private webhookUrl(): string | null {
    const addr = this.deps.publicAddress?.trim();
    if (!addr) return null;
    const host = addr.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `https://${host}/telegram/webhook`;
  }

  private async token(): Promise<string> {
    return (await resolveCredential(this.deps.db, this.deps.encryptionKey, 'telegram_bot_token')) ?? '';
  }

  /** Reconcile the webhook + command menu against desired state. Run at boot
   *  and whenever a telegram_* setting or the token is written (poked from the
   *  settings routes, like the looper). Enabled + token + address present →
   *  register (minting a secret if needed); otherwise tear down. */
  async reconcile(): Promise<void> {
    try {
      const values = await settingsValues(this.turnDeps());
      const enabled = values.telegram_enabled === true;
      const token = await this.token().catch(() => '');
      const url = this.webhookUrl();
      const acc = await store.getAccount(this.deps.db, this.deps.encryptionKey);

      if (!enabled || !token || !url) {
        if (acc.webhookUrl) {
          if (token) await new TelegramClient(token).deleteWebhook().catch(() => {});
          await store.clearRegistration(this.deps.db);
          log.info({ enabled, hasToken: !!token, hasUrl: !!url }, 'telegram disabled — webhook torn down');
        }
        return;
      }

      const client = new TelegramClient(token);
      const me = await client.getMe().catch(() => null);
      const secret = acc.webhookSecret ?? crypto.randomBytes(32).toString('hex');
      // A read on every boot after the first: only re-register when the URL or
      // the subscription drifted (dropPending:false keeps queued messages).
      const info = await client.getWebhookInfo().catch(() => null);
      const registered = info?.url === url
        && ALLOWED_UPDATES.every((u) => (info?.allowed_updates ?? []).includes(u));
      if (!registered || acc.webhookSecret !== secret) {
        await client.setWebhook(url, secret, { dropPending: false });
        await store.saveRegistration(this.deps.db, this.deps.encryptionKey, secret, url, me?.username ?? null);
        log.info({ url }, 'telegram webhook registered');
      }
      // The menu follows the mode: the global default is home's, and the
      // authorized chat gets its current mode's list (chat scope — Telegram
      // pushes a private-chat menu change to the user at once; enterMode swaps
      // it on every transition). Set here too so a restart never leaves a
      // stale one. The menu lives in code, so a bot connected before a
      // command existed still gets it.
      await client.setMyCommands(menuFor('assistant')).catch(() => {});
      const dm = Number(values.telegram_authorized_user ?? '');
      if (Number.isFinite(dm) && dm) await client.setMyCommands(menuFor(acc.mode), dm).catch(() => {});
    } catch (e) {
      log.warn({ err: errStr(e) }, 'telegram reconcile failed');
    }
  }

  // ── webhook ─────────────────────────────────────────────────────────────

  /** Fast-ack the update, then run out-of-band. Returns the HTTP status. */
  async handleUpdate(secretHeader: string, update: any): Promise<number> {
    const { db, encryptionKey } = this.deps;
    const acc = await store.getAccount(db, encryptionKey);
    const values = await settingsValues(this.turnDeps()).catch(() => ({} as Record<string, unknown>));
    if (values.telegram_enabled !== true) return 200;
    if (!acc.webhookSecret || !timingSafeEqualStr(secretHeader, acc.webhookSecret)) return 403;

    const authorized = String(values.telegram_authorized_user ?? '');
    const dm = Number(authorized);
    if (!authorized || !Number.isFinite(dm)) return 200;

    const reaction = update.message_reaction;
    if (reaction) {
      if (String(reaction.user?.id) !== authorized) return 200;
      if (!(await store.markUpdate(db, update.update_id))) return 200;
      if (hasEmoji(reaction.new_reaction, REACT_SPEAK) && !hasEmoji(reaction.old_reaction, REACT_SPEAK)) {
        this.speakReacted(reaction, dm).catch((e) => log.warn({ err: errStr(e) }, 'speak-reacted failed'));
      }
      return 200;
    }

    // A tap on an approval bubble's button.
    const tap = update.callback_query;
    if (tap) {
      if (String(tap.from?.id) !== authorized) return 200;
      if (!(await store.markUpdate(db, update.update_id))) return 200;
      const client = new TelegramClient(await this.token());
      this.approvals.handleCallback(client, dm, { id: String(tap.id), data: tap.data })
        .catch((e) => log.warn({ err: errStr(e) }, 'approval tap failed'));
      return 200;
    }

    const msg = update.message;
    if (!msg || String(msg.from?.id) !== authorized) return 200;
    if (!(await store.markUpdate(db, update.update_id))) return 200;

    this.run(dm, msg, values).catch((e) => log.error({ err: errStr(e) }, 'telegram turn failed'));
    return 200;
  }

  // ── the turn ─────────────────────────────────────────────────────────────

  private async run(dm: number, msg: any, values: Record<string, unknown>): Promise<void> {
    const { db, encryptionKey } = this.deps;
    const token = await this.token();
    // The client records every bubble it sends, tagged with the current mode's
    // origin, so a reply or a reaction can find its conversation.
    let origin: store.SentOrigin = { kind: 'assistant' };
    const client = new TelegramClient(token,
      (id, text) => { store.recordSent(db, dm, id, text, origin).catch(() => {}); },
      (id) => { store.deleteSent(db, dm, id).catch(() => {}); });

    try {
      // A reply to one of my bubbles switches conversation BEFORE anything
      // reads which mode this is — commands included.
      await this.switchForReply(client, dm, msg);

      const typed = String(msg.text ?? msg.caption ?? '').trim();
      if (typed.startsWith('/')) {
        await handleCommand(this, client, dm, typed);
        return;
      }

      const acc = await store.getAccount(db, encryptionKey);
      origin = acc.mode === 'code' && acc.activeSessionId
        ? { kind: 'session', sessionId: acc.activeSessionId }
        : { kind: 'assistant' };

      const input = await this.resolveInput(client, dm, msg, values, acc);
      if (input === null) return;

      // A question standing: the exact word answers it and is nothing else;
      // any other message declines it and goes on to queue as the follow-up.
      if (this.approvals.handleText(dm, input)) return;

      // Busy: queue the message into the running turn's follow-up and stop.
      const running = this.busy.get(dm);
      if (running) {
        running.queue.push(input);
        await client.sendMessage(dm, '⌛ Got it — after this turn.', { replyToMessageId: msg.message_id });
        return;
      }

      if (acc.mode === 'code' && acc.activeSessionId) {
        await this.codeTurn(client, dm, acc.activeSessionId, input, values);
      } else {
        await this.assistantTurn(client, dm, input, values);
      }
    } catch (e) {
      await client.sendMessage(dm, `⚠️ Something went wrong:\n${(e as Error).message}`).catch(() => {});
      throw e;
    }
  }

  /** An assistant-mode turn: the in-memory Assistant conversation, streamed to
   *  the bubble. session_switch moves the active-session POINTER only — the
   *  assistant keeps the conversation; /code is how the user hands it over. */
  private async assistantTurn(client: TelegramClient, dm: number, message: string,
    values: Record<string, unknown>): Promise<void> {
    const { db } = this.deps;
    const typing = startTyping(client, dm);
    const abort = new AbortController();
    this.busy.set(dm, { queue: [], abort });
    const acc = await store.getAccount(db, this.deps.encryptionKey);
    // The assistant can deliver a file it names from the active session's work
    // dir (its file tools are read-only, but it can point at one the coder made).
    const sink = makeTelegramSink(client, dm,
      acc.activeSessionId ? this.deliverConfig(acc.activeSessionId) : undefined);
    const deps: AssistantDeps = { f: this.f, apiKey: this.deps.apiKey, modelFetch: this.deps.modelFetch };
    let replyText = '';
    // The pointer as this turn sees it — live across a switch within the turn.
    let active = acc.activeSessionId ?? null;
    try {
      const onSwitch = async (id: string) => {
        const r = await this.switchSession(client, dm, id);
        if ('error' in r) return r;
        active = r.id;
        return { active: r.id, title: r.title,
          note: "You are still the assistant — this session's files are now what your read tools see. " +
            'The user sends /code to talk to its coding agent; you never enter it.' };
      };
      // A new workspace: make it active and open a session in it — what /new
      // does, so the user lands talking to the coder like the cli's "on screen".
      const onWorkspaceCreated = async (workspaceId: string) => {
        await store.setActiveWorkspace(db, workspaceId);
        const j = await (await this.call('/sessions', { method: 'POST', body: { workspace_id: workspaceId } })).json();
        if (!j.ok) return { error: j.error?.message as string };
        await store.setActiveSession(db, j.data.id);
        await this.enterMode(client, dm, 'code');
        await client.sendMessage(dm, '🆕 New session in the new workspace. Send your first message to begin.');
        return { session: j.data.id as string };
      };
      replyText = await runAssistantTurn(deps, this.assistantHistory, message, sink, {
        settings: values,
        workspaceId: () => acc.activeWorkspaceId ?? null,
        activeSession: () => active,
        onSwitch,
        approve: (ask, signal) => this.approvals.request(client, dm, ask, signal),
        onWorkspaceCreated,
      }, abort.signal);
      // Any messages queued while we ran go out as one follow-up turn.
      const queued = this.busy.get(dm)?.queue ?? [];
      this.busy.delete(dm);
      typing.stop();
      await this.maybeSpeak(client, dm, values, replyText);
      if (queued.length) await this.assistantTurn(client, dm, queued.join('\n\n'), values);
    } catch (e) {
      this.busy.delete(dm);
      typing.stop();
      await client.sendMessage(dm, `⚠️ ${(e as Error).message}`).catch(() => {});
    }
  }

  /** A code-mode turn: a real coding turn on the session, via runCodingTurn,
   *  streamed from the session feed into the bubble. */
  private async codeTurn(client: TelegramClient, dm: number, sessionId: string,
    message: string, values: Record<string, unknown>): Promise<void> {
    const { db } = this.deps;
    let opened: OpenedSession;
    try {
      opened = await openSession({ baseUrl: BASE, apiKey: this.deps.apiKey, clientId: CLIENT_ID,
        label: CLIENT_ID, fetch: this.f, lock: true, sessionId });
    } catch (e) {
      if (e instanceof SessionLockedError) {
        const s = await getSession(db, sessionId);
        await client.sendMessage(dm, `🔒 That session is busy${s?.lockedLabel ? ` (${s.lockedLabel})` : ''} — try again in a moment.`);
        return;
      }
      throw e;
    }

    const typing = startTyping(client, dm);
    const abort = new AbortController();
    this.busy.set(dm, { queue: [], abort });
    // Files the agent names in its reply are delivered from this session's work
    // dir; the agent writes /workspace/... container paths, which map there.
    const sink = makeTelegramSink(client, dm, this.deliverConfig(sessionId));
    // The bubble reads the session feed — the ONE place a coding turn's parts
    // are published. Subscribe before the run; the lock makes this the only
    // turn on the session, so there is no gap.
    const unsubscribe = this.deps.sessionEvents?.subscribe(sessionId, (e) => {
      if (e.event === 'part') sink.part(e.part as Record<string, unknown>);
    });

    try {
      const s = await getSession(db, sessionId);
      const workspaceId = s?.workspaceId ?? '';
      const planMode = s?.planMode === true;
      // The agent's deliberate "DM the user" tool — sends through this chat,
      // reading the reply mode at the delivery end.
      const send = sendMessageTool((text) => this.sendDm(client, dm, values, text));
      const deps: TurnDeps = { ...this.turnDeps(), extraTools: send };
      const r = await runCodingTurn(deps, opened, workspaceId, message, planMode, values);
      unsubscribe?.();
      await sink.done(r.text);
      const queued = this.busy.get(dm)?.queue ?? [];
      this.busy.delete(dm);
      await opened.close();
      typing.stop();
      await this.maybeSpeak(client, dm, values, r.text);
      if (queued.length) await this.codeTurn(client, dm, sessionId, queued.join('\n\n'), values);
      return;
    } catch (e) {
      unsubscribe?.();
      await sink.dispose();
      this.busy.delete(dm);
      await opened.close().catch(() => {});
      typing.stop();
      await client.sendMessage(dm, `⚠️ ${(e as Error).message}`).catch(() => {});
    }
  }

  /** Speak the reply when the mode asks. Text has already gone out (the
   *  sink), so a synthesis failure loses nothing. */
  private async maybeSpeak(client: TelegramClient, dm: number,
    values: Record<string, unknown>, text?: string): Promise<void> {
    const mode = String(values.telegram_reply_mode ?? 'text');
    if (mode !== 'voice' && mode !== 'both') return;
    const say = (text ?? '').trim();
    if (!say) return;
    const apiKey = (await resolveCredential(this.deps.db, this.deps.encryptionKey, 'deepgram_api_key').catch(() => '')) ?? '';
    if (!apiKey) return;
    typingAction(client, dm, 'record_voice');
    const audio = await speakVoice(apiKey, String(values.voice_spoken_voice ?? ''), say.slice(0, SPEAK_MAX_CHARS));
    if (audio) await client.sendVoiceBytes(dm, audio).catch(() => {});
  }

  // ── input: voice, attachments, text ──────────────────────────────────────

  private async resolveInput(client: TelegramClient, dm: number, msg: any,
    values: Record<string, unknown>, acc: store.TelegramAccountRow): Promise<string | null> {
    const typed = String(msg.text ?? msg.caption ?? '').trim();

    // A voice note is the message itself (never `audio` — an mp3 is a file).
    const voice = msg.voice;
    if (voice && !typed) {
      const react = (emoji?: string) => client.setMessageReaction(dm, msg.message_id, emoji).catch(() => {});
      if (voice.file_size && voice.file_size > MAX_INBOUND_BYTES) {
        await client.sendMessage(dm, "⚠️ That voice note is over Telegram's 20 MB limit for bots.");
        return null;
      }
      // The key first (a millisecond, read at point of use like every
      // credential): without one there is nothing to download for.
      const apiKey = (await resolveCredential(this.deps.db, this.deps.encryptionKey, 'deepgram_api_key').catch(() => '')) ?? '';
      if (!apiKey) { await client.sendMessage(dm, NOT_HEARD.no_key); return null; }
      // The ✍ and the download are independent — one round-trip each, so
      // they run together rather than the reaction gating the download.
      const [, audio] = await Promise.all([react(REACT_TRANSCRIBING), client.downloadFile(voice.file_id)])
        .catch(async (e) => { await react(); throw e; });   // run() reports it; the ✍ must not outlive it
      const heard = await transcribeVoice(apiKey, audio, String(values.voice_stt_model ?? ''));
      // Whatever happened, the ✍ comes off: on a hit, the turn starting is
      // the acknowledgement and a lingering reaction is noise.
      await react();
      if ('error' in heard) { await client.sendMessage(dm, NOT_HEARD[heard.error]); return null; }
      if (!heard.text) { await client.sendMessage(dm, "🎤 I couldn't make out any speech in that."); return null; }
      if (values.telegram_transcript_echo === true) await client.sendMessage(dm, `🎤 "${heard.text}"`);
      return heard.text;
    }

    // Everything else file-bearing: save to the session's scratch, describe it.
    // Attachments only land in code mode (there is a session's scratch to use).
    const files = collectFiles(msg);
    if (files.length) {
      if (acc.mode !== 'code' || !acc.activeSessionId) {
        await client.sendMessage(dm, "⚠️ Files go into the session you're coding in — /code to enter one first.");
        return typed || null;
      }
      const scratch = sessionDir(this.deps.paths, acc.activeSessionId) + '/scratch';
      const stored: StoredAttachment[] = [];
      for (const { file, kind } of files) {
        if (file.file_size && file.file_size > MAX_INBOUND_BYTES) {
          await client.sendMessage(dm, `⚠️ "${file.file_name ?? 'that file'}" is over Telegram's 20 MB limit.`);
          continue;
        }
        const a = await writeAttachment(scratch, await client.downloadFile(file.file_id),
          { filename: file.file_name, mimeType: file.mime_type, defaultKind: kind });
        if (a) stored.push(a);
      }
      if (!stored.length) return typed || null;
      return composeMessage(stored, typed);
    }

    if (typed) return typed;
    await client.sendMessage(dm, "ℹ️ Send me a message, a voice note, or a file and I'll get to work.");
    return null;
  }

  // ── telegram_sent: reply-switch and reaction-speak ───────────────────────

  private async switchForReply(client: TelegramClient, dm: number, msg: any): Promise<void> {
    const replied = msg.reply_to_message;
    if (!replied?.message_id) return;
    const stored = await store.getSent(this.deps.db, dm, Number(replied.message_id));
    if (!stored) return;
    const acc = await store.getAccount(this.deps.db, this.deps.encryptionKey);
    if (stored.origin.kind === 'session' && stored.origin.sessionId) {
      if (acc.activeSessionId === stored.origin.sessionId && acc.mode === 'code') return;
      if (acc.activeSessionId !== stored.origin.sessionId) {
        const r = await this.switchSession(client, dm, stored.origin.sessionId);
        if ('error' in r) { await client.sendMessage(dm, '⚠️ That session no longer exists.'); return; }
      }
      await this.enterMode(client, dm, 'code');
    } else {
      if (acc.mode === 'assistant') return;
      // The switch line is the whole message here.
      await this.enterMode(client, dm, 'assistant');
    }
  }

  // ── the two transitions: WHICH session, WHO answers ──────────────────────

  /** Point the account at a session. The pointer only — the mode is untouched,
   *  so the assistant keeps the conversation and a coder is never entered by
   *  accident. Announces the switch; the ONE place the 🔀 line is sent. */
  async switchSession(client: TelegramClient, dm: number, id: string):
  Promise<{ id: string; title: string | null } | { error: string }> {
    const s = await getSession(this.deps.db, id);
    if (!s) return { error: `no session ${id}` };
    await store.setActiveSession(this.deps.db, id);
    await client.sendMessage(dm, `🔀 Active session: ${s.name ?? 'untitled'}`);
    return { id, title: s.name ?? null };
  }

  /** Change who answers a plain message. Announces the transition iff the mode
   *  changed and swaps the chat's command menu to the mode's list. Returns
   *  whether the mode changed. Code mode presumes an active session — the
   *  caller checks (/code) or has just switched (a reply to a coder's bubble). */
  async enterMode(client: TelegramClient, dm: number, mode: store.TelegramMode): Promise<boolean> {
    const changed = await store.setMode(this.deps.db, mode, (t) => client.sendMessage(dm, t));
    await client.setMyCommands(menuFor(mode), dm).catch(() => {});
    return changed;
  }

  private async speakReacted(reaction: any, dm: number): Promise<void> {
    const chatId = Number(reaction.chat?.id);
    const messageId = Number(reaction.message_id);
    if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) return;
    const stored = await store.getSent(this.deps.db, chatId, messageId);
    if (!stored) return;
    const token = await this.token();
    const client = new TelegramClient(token);
    const apiKey = (await resolveCredential(this.deps.db, this.deps.encryptionKey, 'deepgram_api_key').catch(() => '')) ?? '';
    const values = await settingsValues(this.turnDeps()).catch(() => ({} as Record<string, unknown>));
    typingAction(client, dm, 'record_voice');
    const audio = await speakVoice(apiKey, String(values.voice_spoken_voice ?? ''),
      stored.content.replace(/\n\n\(\d+\/\d+\)$/, '').slice(0, SPEAK_MAX_CHARS));
    if (audio) await client.sendVoiceBytes(chatId, audio, { replyToMessageId: messageId }).catch(() => {});
    else await client.sendMessage(chatId, "⚠️ I couldn't turn that into audio — check the Deepgram key.",
      { replyToMessageId: messageId }).catch(() => {});
  }

  // ── /stop and command support (used by commands.ts) ──────────────────────

  /** Stop the in-flight turn for this chat, if any. Returns whether one ran. */
  stop(dm: number): boolean {
    const b = this.busy.get(dm);
    if (!b) return false;
    b.queue.length = 0;
    b.abort.abort();
    return true;
  }

  get store() { return store; }
  get db() { return this.deps.db; }
  get key() { return this.deps.encryptionKey; }
  assistantReset() { this.assistantHistory = []; }

  /** A JSON call to this server's own surface, as the telegram client — the
   *  one door commands.ts reaches the routes through. */
  async call(path: string, init?: { method?: string; body?: unknown; session?: string }): Promise<any> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.deps.apiKey}`, 'x-phantom-looper-client': CLIENT_ID };
    if (init?.body !== undefined) headers['content-type'] = 'application/json';
    if (init?.session) headers['x-phantom-looper-session'] = init.session;
    const r = await this.f(`${BASE}${path}`, {
      method: init?.method ?? 'GET', headers,
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    // auto-push streams ND-JSON, not a JSON object — the caller reads .raw then.
    return { json: () => r.json(), text: () => r.text() };
  }

  private turnDeps(): TurnDeps {
    return { f: this.f, apiKey: this.deps.apiKey, base: BASE,
      modelFetch: this.deps.modelFetch, sessionEvents: this.deps.sessionEvents, client: CLIENT_ID };
  }

  /** File delivery for a session's reply: map the agent's /workspace/... paths
   *  to host files under the session's work dir, and confine delivery there. */
  private deliverConfig(sessionId: string): DeliverConfig {
    const root = sessionDir(this.deps.paths, sessionId);   // host view of /workspace
    return {
      roots: [root],
      toHost: (p) => p.startsWith('/workspace')
        ? path.join(root, p.slice('/workspace'.length))
        : p,
    };
  }

  /** Deliver one deliberate message (send_message tool, or the assistant): the
   *  text as a bubble, spoken too when the reply mode asks. */
  private async sendDm(client: TelegramClient, dm: number, values: Record<string, unknown>, text: string):
  Promise<{ ok: boolean; error?: string }> {
    const say = String(text ?? '').trim();
    if (!say) return { ok: false, error: 'empty message' };
    const mode = String(values.telegram_reply_mode ?? 'text');
    try {
      if (mode !== 'voice') {
        for (const c of splitFormatted(toTelegram(say))) await client.sendMessage(dm, c.text, { entities: c.entities });
      }
      if (mode === 'voice' || mode === 'both') await this.maybeSpeak(client, dm, values, say);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

const TYPING_MS = 4000;
function startTyping(client: TelegramClient, dm: number) {
  const ping = () => client.sendChatAction(dm, 'typing').catch(() => {});
  ping();
  const timer = setInterval(ping, TYPING_MS);
  return { stop() { clearInterval(timer); } };
}
function typingAction(client: TelegramClient, dm: number, action: string) {
  client.sendChatAction(dm, action).catch(() => {});
}

function hasEmoji(list: any, emoji: string): boolean {
  return Array.isArray(list) && list.some((r) => r?.type === 'emoji' && r?.emoji === emoji);
}

const MEDIA_FIELDS: Array<{ field: string; kind?: 'image' | 'video' | 'audio' }> = [
  { field: 'photo', kind: 'image' }, { field: 'document' },
  { field: 'video', kind: 'video' }, { field: 'animation', kind: 'video' },
  { field: 'audio', kind: 'audio' },
];
function collectFiles(msg: any): Array<{ file: any; kind?: 'image' | 'video' | 'audio' }> {
  const out: Array<{ file: any; kind?: 'image' | 'video' | 'audio' }> = [];
  for (const { field, kind } of MEDIA_FIELDS) {
    const v = msg?.[field];
    if (!v) continue;
    out.push({ file: Array.isArray(v) ? v[v.length - 1] : v, kind });
  }
  return out;
}
