// The Telegram engine: the bot as a client of this server. Started after
// listen (like the looper), reaching the routes through injectFetch. One
// authorized user, DM-only, webhook (never polling). Two modes on one sticky
// bot state row: ASSISTANT (home — the Assistant answers, board/cards/sessions)
// and CODE (inside a session — a plain message runs a coding turn on it).
//
// Design is phantom-looper's, not shockwave's: sessions are explicit and
// long-lived (no lazy chat minting, no per-message checkout prep), the
// Assistant is the primary agent, work lands only through /auto_push, and voice
// is Deepgram-only. Mechanisms (the streaming bubble, entities, telegram_sent_messages,
// attachments, the escape-spelled reactions) are ported from ../shockwave.

import crypto from 'node:crypto';
import { timingSafeEqualStr } from '../crypto.js';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Paths } from '../pool/paths.js';
import { sessionDir } from '../pool/paths.js';
import { injectFetch } from '../looper/injectFetch.js';
import { runCodingTurn, type TurnDeps } from '../looper/turn.js';
import { sessionPin } from '../agentConfig.js';
import type { SettingKey } from '../settings.js';
import type { SettingsEvents } from '../api/settingsEvents.js';
import { APP_VERSION } from '../env.js';
import { openSession, SessionLockedError, type OpenedSession } from '../../core/session.js';
import type { Sessions } from '../sessions.js';
import type { Cards } from '../cards.js';
import type { Presets } from '../presets.js';
import type { System } from '../system.js';
import type { Settings } from '../settings.js';
import type { SessionEvents } from '../api/sessionEvents.js';
import type { BackdoorQueue } from '../api/backdoor.js';
import type { BoardEvents, BoardEvent } from '../api/boardEvents.js';
import { autoBuildAlert } from './alerts.js';
import { logger, errStr } from '../log.js';
import { TelegramClient, ALLOWED_UPDATES, titled } from './client.js';
import { makeTelegramSink, type DeliverConfig } from './sink.js';
import { startWaitingBubble } from './bubble.js';
import { transcribeVoice, speakVoice, splitForSpeech, SPEAK_MAX_CHARS, type Transcription } from './deepgram.js';
import { writeAttachment, composeMessage, MAX_INBOUND_BYTES, type StoredAttachment } from './attachments.js';
import { runAssistantTurn, CLIENT_ID, type AssistantDeps } from './assistant.js';
import { Approvals, type Ask } from './approvals.js';
import { UpgradeChecker } from './upgrade.js';
import type { TelegramBotState, TelegramBotStateRow, TelegramMode } from './botState.js';
import type { TelegramSentMessages } from './sentMessages.js';
import type { TelegramHandledUpdates } from './handledUpdates.js';
import { menuFor, handleCommand } from './commands.js';
import { AUTO_PUSH_STEPS, AUTO_PULL_STEPS, type AutoPushOutcome, type AutoPullOutcome } from '../../core/llm/tools/git.js';
import type { AutoPushEvent } from '../git/autoPush.js';
import type { AutoPullEvent } from '../git/autoPull.js';
import type { SessionRow, WorkspaceRow } from '../db/schema.js';
import type { Workspaces } from '../workspaces.js';
import { AssistantConversation } from './assistantConversation.js';


const log = logger('telegram');
const BASE = 'http://looper/api';

// Progress on a voice message itself. WRITTEN AS ESCAPES — Telegram's reaction
// set carries no variation selectors, and a picker-pasted glyph brings one,
// yielding REACTION_INVALID.
const REACT_TRANSCRIBING = '\u{270D}';   // ✍ writing hand, no U+FE0F — replaced by 👍 when heard
const REACT_HEARD = '\u{1F44D}';         // 👍 — transcription done
const REACT_SPEAK = '\u{1F92C}';         // 🤬 — the user's "read this back" gesture

// What the user reads when a voice note could not be heard, by reason.
const NOT_HEARD: Record<Extract<Transcription, { error: string }>['error'], string> = {
  no_key: '🎤 Voice transcription needs a Deepgram key — add one in /keys.',
  unreachable: "🎤 Couldn't reach Deepgram — send that again in a moment.",
  vendor: "🎤 Deepgram couldn't transcribe that — send it again.",
};

export interface TelegramEngineDeps {
  /** Telegram's own rows — one owner per table (see each file). */
  botState: TelegramBotState;
  sentMessages: TelegramSentMessages;
  handledUpdates: TelegramHandledUpdates;
  settings: Settings;
  sessions: Sessions;
  cards: Cards;
  workspaces: Workspaces;
  presets: Presets;
  system: System;
  paths: Paths;
  /** The turn runtime an interrupt reaches: in-process turns and foreground commands. */
  activeTurns?: Map<string, AbortController>;
  foreground?: { killAll(id: string): void };
  /** The loops in flight — what an api restart would cut (the upgrade checker warns). */
  loopsRunning?: () => number;
  app: FastifyInstance;
  apiKey: string;
  sessionEvents?: SessionEvents;
  /** The board bus — the auto build alerts listen on it (alerts.ts). */
  events?: BoardEvents;
  /** The settings feed — a telegram_* key or the bot token written, through
   *  any door, reconciles the webhook and the command menu. */
  settingsEvents?: SettingsEvents;
  /** The backdoor message queue (api/backdoor.ts) — each turn drains its
   *  session's queue. */
  backdoor?: BackdoorQueue;
  modelFetch?: typeof fetch;
  /** https://PHANTOM_BACKEND_ADDRESS — the only source of the webhook URL. */
  publicAddress?: string;
  /** Direct auto-push / auto-pull — bypasses injectFetch so onEvent fires
   *  as each step completes instead of all at once after the stream ends. */
  autoPush?: (session: SessionRow, workspace: WorkspaceRow,
    onEvent?: (e: AutoPushEvent) => void | Promise<void>, by?: string) => Promise<AutoPushOutcome>;
  autoPull?: (session: SessionRow, workspace: WorkspaceRow,
    onEvent?: (e: AutoPullEvent) => void | Promise<void>, by?: string) => Promise<AutoPullOutcome>;
}

/** A turn in flight on THIS server, keyed per session (code mode) or
 *  'assistant'. A second message to the SAME key is queued and sent as one
 *  follow-up turn (the cli's queue shape); a message to a DIFFERENT key
 *  starts its own turn — so multiple sessions can run concurrently. A code
 *  turn's AbortController rides into runCodingTurn and is aborted two ways:
 *  /stop through this map, a remote interrupt through the turn's feed
 *  subscription; the assistant's stop is local (it is not a session). */
interface InFlightTurn { queue: string[]; abort: AbortController }

export class TelegramEngine {
  private fetch: typeof globalThis.fetch;
  private inFlight = new Map<string, InFlightTurn>();
  /** Album debounce: Telegram sends multi-photo sends as separate updates
   *  sharing a `media_group_id`. A short timer collects them and runs once. */
  private albums = new Map<string, { msgs: any[]; timer: NodeJS.Timeout }>();

  /** The Assistant's conversation — history, transcript, compaction. */
  readonly conversation: AssistantConversation;

  /** The approval gate — gated tools ask the user here (approvals.ts). */
  private approvals = new Approvals();
  /** The upgrade checker — periodic GitHub release check + Telegram notification. */
  upgradeChecker: UpgradeChecker;

  constructor(private deps: TelegramEngineDeps) {
    this.fetch = injectFetch(deps.app);
    this.conversation = new AssistantConversation({
      dataRoot: deps.paths.root,
      sessions: deps.sessions,

    });
    this.upgradeChecker = new UpgradeChecker({
      version: APP_VERSION,
      health: async () => ({ version: APP_VERSION, loops_running: deps.loopsRunning?.() ?? 0 }),
      triggerUpdate: async (tag, onEvent) => {
        // restart_anyway: the approval DM already warns that running turns
        // are stopped and loop cards blocked — a tap on Approve is the
        // informed yes the update guard asks for.
        try {
          let last: string | undefined;
          await deps.system.update(tag, { restartAnyway: true }, (e) => { last = e.event; onEvent?.(e); }).done;
          return last === 'error' ? { ok: false, error: 'update failed' } : { ok: true };
        } catch (e) { return { ok: false, error: (e as Error).message }; }
      },
      setting: (key) => deps.settings.resolve(key as SettingKey),
      token: () => this.token(),
      authorizedUser: () => this.authorizedUser(),
      makeClient: (token, dm) => this.trackedClient(token, dm, () => null),
    });
    // Every card write in the system, all workspaces; alerts.ts decides which
    // are the loop's moves. Fire-and-forget: an alert that fails is logged,
    // never retried, and never touches the card.
    deps.events?.subscribeAll((workspaceId, e) => {
      this.alert(workspaceId, e).catch((err) => log.warn({ err: errStr(err) }, 'auto build alert failed'));
    });
    deps.settingsEvents?.subscribe((e) => {
      if (e.keys.some((k) => k === 'telegram_enabled' || k === 'telegram_authorized_user' || k === 'telegram_bot_token')) void this.reconcile();
    });
  }

  // ── client factory ────────────────────────────────────────────────────────

  /** A TelegramClient that records every sent/deleted message in
   *  sentMessages. `sessionId` is a function so it can track a mutable
   *  pointer (the active session changes mid-turn); null = the assistant's. */
  private trackedClient(token: string, dm: number, sessionId: () => string | null): TelegramClient {
    return new TelegramClient(token,
      (id, text) => { this.deps.sentMessages.record(dm, id, text, sessionId()).catch(
        (e) => log.warn({ err: errStr(e) }, 'sent message not recorded')); },
      (id) => { this.deps.sentMessages.delete(dm, id).catch(
        (e) => log.warn({ err: errStr(e) }, 'sent message not forgotten')); });
  }

  // ── auto build alerts ────────────────────────────────────────────────────

  /** One DM per loop move into in_progress / blocked / done, when
   *  `telegram_auto_build_notifications` resolves on for that workspace and
   *  the bot is enabled for an authorized user. The bubble is recorded with
   *  the card's coding session as its origin, so a reply to it enters that
   *  session in code mode like a reply to any coder bubble. */
  private async alert(workspaceId: string, e: BoardEvent): Promise<void> {
    if (e.event !== 'card' || !e.from || e.from === e.card.status) return;   // the cheap test first — no I/O
    const workspace = await this.deps.workspaces.get(workspaceId);
    if (!workspace) return;
    const alertMsg = autoBuildAlert(e, await this.deps.workspaces.prefixOf(workspace));
    if (!alertMsg) return;
    // The switch resolved at this workspace's layer.
    const s = await this.deps.settings.resolveMany(
      ['telegram_auto_build_notifications', 'telegram_enabled', 'telegram_authorized_user'], { workspace });
    if (s.telegram_auto_build_notifications !== true || s.telegram_enabled !== true) return;
    const dm = Number(s.telegram_authorized_user ?? '');
    if (!dm || !Number.isFinite(dm)) return;
    const token = await this.token();
    if (!token) return;
    const coder = await this.deps.sessions.coderOf(workspaceId, alertMsg.number);
    const client = this.trackedClient(token, dm, () => coder?.id ?? null);
    await client.sendMessage(dm, alertMsg.text);
    log.info({ workspace: workspaceId, card: alertMsg.number, status: alertMsg.status }, 'auto build alert sent');
  }

  // ── setup ─────────────────────────────────────────────────────────────

  /** The webhook URL — never a setting: always https + the public address. */
  private webhookUrl(): string | null {
    const addr = this.deps.publicAddress?.trim();
    if (!addr) return null;
    const host = addr.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `https://${host}/api/telegram/webhook`;
  }

  private async token(): Promise<string> {
    return (await this.deps.settings.credential('telegram_bot_token')) ?? '';
  }

  /** The one chat the bot talks to, or null when none is set. */
  private async authorizedUser(): Promise<number | null> {
    const dm = Number(await this.deps.settings.resolve('telegram_authorized_user') ?? '');
    return Number.isFinite(dm) && dm ? dm : null;
  }

  /** The reply mode, read where a reply is about to be sent. */
  private async voiceOnly(): Promise<boolean> {
    return String(await this.deps.settings.resolve('telegram_reply_mode')) === 'voice';
  }

  /** Reconcile the webhook + command menu against desired state. Run at boot
   *  and whenever a telegram_* setting or the token is written (poked from the
   *  settings routes, like the looper). Enabled + token + address present →
   *  register (minting a secret if needed); otherwise tear down. */
  async reconcile(): Promise<void> {
    try {
      const enabled = await this.deps.settings.resolve('telegram_enabled') === true;
      const token = await this.token();
      const url = this.webhookUrl();
      const bot = await this.deps.botState.read();

      if (!enabled || !token || !url) {
        if (bot.webhookUrl) {
          if (token) await new TelegramClient(token).deleteWebhook().catch(() => {});
          await this.deps.botState.clearRegistration();
          log.info({ enabled, hasToken: !!token, hasUrl: !!url }, 'telegram disabled — webhook torn down');
        }
        return;
      }

      const client = new TelegramClient(token);
      const me = await client.getMe().catch((e: Error) => { log.warn({ err: e.message }, 'getMe failed — the bot has no name this boot'); return null; });
      const secret = bot.webhookSecret ?? crypto.randomBytes(32).toString('hex');
      // A read on every boot after the first: only re-register when the URL or
      // the subscription drifted (dropPending:false keeps queued messages).
      const info = await client.getWebhookInfo().catch((e: Error) => { log.warn({ err: e.message }, 'getWebhookInfo failed — re-registering'); return null; });
      const registered = info?.url === url
        && ALLOWED_UPDATES.every((u) => (info?.allowed_updates ?? []).includes(u));
      if (!registered || bot.webhookSecret !== secret) {
        await client.setWebhook(url, secret, { dropPending: false });
        await this.deps.botState.saveRegistration(secret, url, me?.username ?? null);
        log.info({ url }, 'telegram webhook registered');
      }
      // The menu follows the mode: the global default is home's, and the
      // authorized chat gets its current mode's list (chat scope — Telegram
      // pushes a private-chat menu change to the user at once; enterMode swaps
      // it on every transition). Set here too so a restart never leaves a
      // stale one. The menu lives in code, so a bot connected before a
      // command existed still gets it.
      await client.setMyCommands(menuFor('assistant')).catch(() => {});
      const dm = await this.authorizedUser();
      if (dm) await client.setMyCommands(menuFor(bot.mode), dm).catch(() => {});
    } catch (e) {
      log.warn({ err: errStr(e) }, 'telegram reconcile failed');
    }
  }

  // ── webhook ─────────────────────────────────────────────────────────────

  /** Fast-ack the update, then run out-of-band. Returns the HTTP status. */
  async handleUpdate(secretHeader: string, update: any): Promise<number> {
    const bot = await this.deps.botState.read();
    // A settings read that fails THROWS here: the webhook route answers 500
    // and Telegram retries, instead of the message being dropped as
    // "telegram disabled".
    if (await this.deps.settings.resolve('telegram_enabled') !== true) return 200;
    if (!bot.webhookSecret || !timingSafeEqualStr(secretHeader, bot.webhookSecret)) return 403;

    const dm = await this.authorizedUser();
    if (!dm) return 200;
    const authorized = String(dm);

    const reaction = update.message_reaction;
    if (reaction) {
      if (String(reaction.user?.id) !== authorized) return 200;
      if (!(await this.deps.handledUpdates.markHandled(update.update_id))) return 200;
      if (hasEmoji(reaction.new_reaction, REACT_SPEAK) && !hasEmoji(reaction.old_reaction, REACT_SPEAK)) {
        this.speakReacted(reaction, dm).catch((e) => log.warn({ err: errStr(e) }, 'speak-reacted failed'));
      }
      return 200;
    }

    // A tap on an inline button: approval gate (apv:) or upgrade (upg:).
    const tap = update.callback_query;
    if (tap) {
      if (String(tap.from?.id) !== authorized) return 200;
      if (!(await this.deps.handledUpdates.markHandled(update.update_id))) return 200;
      const client = new TelegramClient(await this.token());
      const q = { id: String(tap.id), data: tap.data as string | undefined };
      if (UpgradeChecker.isUpgradeCallback(tap.data)) {
        this.upgradeChecker.handleCallback(client, dm, q)
          .catch((e) => log.warn({ err: errStr(e) }, 'upgrade tap failed'));
      } else {
        this.approvals.handleCallback(client, dm, q)
          .catch((e) => log.warn({ err: errStr(e) }, 'approval tap failed'));
      }
      return 200;
    }

    const msg = update.message;
    if (!msg || String(msg.from?.id) !== authorized) return 200;
    if (!(await this.deps.handledUpdates.markHandled(update.update_id))) return 200;

    // An album (several photos sent at once) arrives as SEPARATE updates
    // sharing a media_group_id. Collect them briefly and run as one turn,
    // so the agent sees all photos together instead of each as its own task.
    const groupId = msg.media_group_id ? String(msg.media_group_id) : null;
    if (groupId) {
      const entry = this.albums.get(groupId) ?? { msgs: [] as any[], timer: null as any };
      entry.msgs.push(msg);
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        this.albums.delete(groupId);
        this.handleMessage(dm, entry.msgs).catch((e) => log.error({ err: errStr(e) }, 'telegram turn failed'));
      }, 800);
      this.albums.set(groupId, entry);
      return 200;
    }

    this.handleMessage(dm, [msg]).catch((e) => log.error({ err: errStr(e) }, 'telegram turn failed'));
    return 200;
  }

  // ── the turn ───────────────────────────────────────────────────────────────────────

  private async handleMessage(dm: number, msgs: any[]): Promise<void> {
    const msg = msgs[0];
    const token = await this.token();
    // Which conversation a sent bubble belongs to. A function so the tracked
    // client always records the CURRENT value — it moves from the assistant
    // (null) to a session once the bot state is read, and the closure follows.
    let sessionId: string | null = null;
    const client = this.trackedClient(token, dm, () => sessionId);

    try {
      // Show life immediately — before resolveInput (voice download +
      // transcription can take 1-3s) so the user never stares at nothing.
      client.sendChatAction(dm, 'typing').catch(() => {});

      // A reply to one of my bubbles switches conversation BEFORE anything
      // reads which mode this is — commands included. Telegram puts the reply
      // on whichever album item carried it, so check all of them.
      for (const m of msgs) await this.switchForReply(client, dm, m);

      // Typed text: Telegram puts the caption on only one album item.
      const typed = msgs.map((m) => String(m.text ?? m.caption ?? '').trim()).find(Boolean) ?? '';
      if (typed.startsWith('/')) {
        await handleCommand(this, client, dm, typed);
        return;
      }

      const bot = await this.deps.botState.read();
      sessionId = bot.mode === 'code' ? bot.activeSessionId : null;

      const input = await this.resolveInput(client, dm, msgs, bot);
      if (input === null) return;

      // A question standing: the exact word answers it and is nothing else;
      // any other message declines it and goes on to queue as the follow-up.
      if (this.approvals.handleText(dm, input)) return;

      // Busy: queue the message into the SAME key's running turn. Code-mode
      // turns key by sessionId, so switching sessions starts independently;
      // the assistant is one conversation, so it stays one key.
      const busyKey = bot.mode === 'code' && bot.activeSessionId
        ? bot.activeSessionId : 'assistant';
      const running = this.inFlight.get(busyKey);
      if (running) {
        running.queue.push(input);
        await client.sendMessage(dm, '⌛ Got it — after this turn.', { replyToMessageId: msg.message_id });
        return;
      }

      if (bot.mode === 'code' && bot.activeSessionId) {
        await this.codeTurn(client, dm, bot.activeSessionId, input);
      } else {
        await this.assistantTurn(client, dm, input);
      }
    } catch (e) {
      await client.sendMarkdown(dm, titled('⚠️ Something went wrong', (e as Error).message)).catch(() => {});
      throw e;
    }
  }

  /** An assistant-mode turn: the in-memory Assistant conversation, streamed to
   *  the bubble. session_switch moves the active-session POINTER only — the
   *  assistant keeps the conversation; /code is how the user hands it over. */
  private async assistantTurn(client: TelegramClient, dm: number, message: string): Promise<void> {
    const conv = this.conversation;
    conv.chat = { client, dm };
    conv.load();
    const typing = startTyping(client, dm);
    const abort = new AbortController();
    const busyKey = 'assistant';
    this.inFlight.set(busyKey, { queue: [], abort });
    const bot = await this.deps.botState.read();
    // The assistant can deliver a file it names from the active session's work
    // dir (its file tools are read-only, but it can point at one the coder made).
    const sink = makeTelegramSink(client, dm,
      bot.activeSessionId ? this.deliverConfig(bot.activeSessionId) : undefined,
      { voiceOnly: await this.voiceOnly() });
    const deps: AssistantDeps = { f: this.fetch, apiKey: this.deps.apiKey, modelFetch: this.deps.modelFetch,
      cards: this.deps.cards, workspaces: this.deps.workspaces };
    let replyText = '';
    // The pointer as this turn sees it — live across a switch within the turn.
    let active = bot.activeSessionId ?? null;
    try {
      // The assistant's session row exists BEFORE its agent is built: the
      // turn runs on the row's model, its tools open the row's folder, and
      // every call is billed to it.
      const own = await conv.ensureSession(bot.activeWorkspaceId, bot.activeSessionId);
      const workspace = bot.activeWorkspaceId ? await this.deps.workspaces.get(bot.activeWorkspaceId) : undefined;
      const config = await this.deps.settings.agentConfig('assistant', { workspace, pin: sessionPin(own) });
      conv.compaction = config.compaction;
      const onSwitch = async (id: string) => {
        const r = await this.switchSession(client, dm, id);
        if ('error' in r) return r;
        active = r.id;
        // The assistant's folder follows the switch mid-turn: its read tools
        // open the row's folder, so the very next call sees the new files.
        await this.deps.sessions.follow(own.id, bot.activeWorkspaceId!, r.id);
        return { active: r.id, title: r.title,
          note: "You are still the assistant — this session's files are now what your read tools see. " +
            'The user sends /code to talk to its coding agent; you never enter it.' };
      };
      // A new workspace: make it active and open a session in it — what /new
      // does, so the user lands talking to the coder like the cli's "on screen".
      const onWorkspaceCreated = async (workspaceId: string) => {
        await this.deps.botState.setActiveWorkspace(workspaceId);
        let started;
        try { started = await this.deps.sessions.start(workspaceId); }
        catch (e) { return { error: (e as Error).message }; }
        await this.deps.botState.setActiveSession(started.id);
        await this.enterMode(client, dm, 'code');
        await client.sendMessage(dm, '🆕 New session in the new workspace. Send your first message to begin.');
        return { session: started.id };
      };
      const result = await runAssistantTurn(deps, conv.history, message, sink, {
        config,
        workspaceId: () => bot.activeWorkspaceId ?? null,
        activeSession: () => active,
        onSwitch,
        approve: (ask, signal) => this.approvals.request(client, dm, ask, signal),
        onWorkspaceCreated,
      }, abort.signal, conv.getTranscript(), own);
      replyText = result.said;
      await this.deps.sessions.turnEnded(own).catch(
        (e) => log.warn({ err: errStr(e) }, 'assistant session update failed'));
      // Long chat? Summarize it in the background — turns never wait on it.
      conv.kickCompaction(result.usage.input);
      // Any messages queued while we ran go out as one follow-up turn.
      const queued = this.inFlight.get(busyKey)?.queue ?? [];
      this.inFlight.delete(busyKey);
      await this.maybeSpeak(client, dm, replyText, typing);
      typing.stop();
      if (queued.length) await this.assistantTurn(client, dm, queued.join('\n\n'));
    } catch (e) {
      this.inFlight.delete(busyKey);
      typing.stop();
      const msg = (e as Error).message;
      const isPromptTooLong = /prompt is too long|request too large/i.test(msg);
      log.error({ err: errStr(e) }, 'assistant turn failed');
      await client.sendMessage(dm, isPromptTooLong
        ? '⚠️ Chat history exceeds the model\'s limit — send /compact to free space, then try again.'
        : `⚠️ ${msg}`).catch(() => {});
    }
  }

  /** A code-mode turn: a real coding turn on the session, via runCodingTurn,
   *  streamed from the session feed into the bubble. */
  private async codeTurn(client: TelegramClient, dm: number, sessionId: string, message: string): Promise<void> {
    let opened: OpenedSession;
    try {
      opened = await openSession({ baseUrl: BASE, apiKey: this.deps.apiKey, clientId: CLIENT_ID,
        label: CLIENT_ID, fetch: this.fetch, lock: true, sessionId });
    } catch (e) {
      if (e instanceof SessionLockedError) {
        const s = await this.deps.sessions.get(sessionId);
        await client.sendMessage(dm, `🔒 That session is busy${s?.lockedLabel ? ` (${s.lockedLabel})` : ''} — try again in a moment.`);
        return;
      }
      throw e;
    }

    const typing = startTyping(client, dm);
    const abort = new AbortController();
    this.inFlight.set(sessionId, { queue: [], abort });
    // Files the agent names in its reply are delivered from this session's work
    // dir; the agent writes /workspace/... container paths, which map there.
    const sink = makeTelegramSink(client, dm, this.deliverConfig(sessionId), { voiceOnly: await this.voiceOnly() });
    // The bubble reads the session feed — the ONE place a coding turn's parts
    // are published. Subscribe before the run; the lock makes this the only
    // turn on the session, so there is no gap. The same feed carries the stop
    // signal: an `interrupt` (esc-esc in a cli window, the interrupt route)
    // aborts this turn exactly as /stop does.
    const unsubscribe = this.deps.sessionEvents?.subscribe(sessionId, (e) => {
      if (e.event === 'part') sink.part(e.part as Record<string, unknown>);
      else if (e.event === 'interrupt') abort.abort();
    });

    try {
      const s = await this.deps.sessions.get(sessionId);
      const workspaceId = s?.workspaceId ?? '';
      const planMode = s?.planMode === true;
      const workspace = s ? await this.deps.workspaces.get(s.workspaceId) : undefined;
      const cfg = await this.deps.settings.agentConfig('coding', { workspace, pin: sessionPin(opened.session) });
      // `signal` is what makes the turn stoppable at all: /stop aborts this
      // controller through the inFlight map, a remote interrupt through the feed
      // subscription above — runCodingTurn ends it cleanly (interrupted, not
      // failed) either way.
      const deps: TurnDeps = { ...this.turnDeps(), signal: abort.signal };
      const r = await runCodingTurn(deps, opened, workspaceId, message, planMode, cfg);
      unsubscribe?.();
      const said = await sink.done(r.text);
      const queued = this.inFlight.get(sessionId)?.queue ?? [];
      this.inFlight.delete(sessionId);
      await opened.close();
      await this.maybeSpeak(client, dm, said, typing);
      typing.stop();
      if (queued.length) await this.codeTurn(client, dm, sessionId, queued.join('\n\n'));
      return;
    } catch (e) {
      unsubscribe?.();
      await sink.dispose();
      this.inFlight.delete(sessionId);
      await opened.close().catch(() => {});
      typing.stop();
      log.error({ err: errStr(e) }, 'code turn failed');
      await client.sendMessage(dm, `⚠️ ${(e as Error).message}`).catch(() => {});
    }
  }

  /** Speak the reply when the mode asks. Long replies are split into chunks
   *  so audio starts playing in under a second — two synthesis requests fly
   *  in parallel, sent in order, dots between pieces. In `voice` mode the
   *  sink withheld the text, so a failed synthesis falls back to sending it.
   *  `typing` is the turn's indicator loop — swapped to `record_voice` while
   *  synthesis runs so the user sees "recording audio…" instead of "typing…". */
  private async maybeSpeak(client: TelegramClient, dm: number, text?: string,
    typing?: { set(a: string): void }): Promise<void> {
    const mode = String(await this.deps.settings.resolve('telegram_reply_mode'));
    if (mode !== 'voice' && mode !== 'both') return;
    const say = (text ?? '').trim();
    if (!say) return;
    const apiKey = await this.deps.settings.credential('deepgram_api_key');
    if (!apiKey) {
      if (mode === 'voice') await client.sendMarkdown(dm, say).catch(() => {});
      return;
    }
    typing?.set('record_voice');
    const voice = String(await this.deps.settings.resolve('voice_spoken_voice'));
    const chunks = splitForSpeech(say);
    if (!chunks.length) return;

    // Single chunk — the common case, no pipeline needed.
    if (chunks.length === 1) {
      const audio = await speakVoice(apiKey, voice, chunks[0]);
      if (audio) await client.sendVoiceBytes(dm, audio).catch(() => {});
      else if (mode === 'voice') await client.sendMarkdown(dm, say).catch(() => {});
      return;
    }

    // Multi-chunk: 2 synthesis requests in parallel, send in order, dots
    // between pieces. Synthesis is ~260ms flat (measured), playback is ~24s
    // per 2000 chars, so every chunk after #1 is ready long before it's needed.
    const jobs: (Promise<Buffer | null> | undefined)[] = [];
    const startJob = (i: number) => {
      if (i >= chunks.length || jobs[i]) return;
      jobs[i] = speakVoice(apiKey, voice, chunks[i]);
    };
    startJob(0); startJob(1);

    let sent = 0;
    for (let i = 0; i < chunks.length; i++) {
      const bubble = i === 0 ? null : startWaitingBubble(client, dm);
      try {
        const audio = await jobs[i]!;
        startJob(i + 2);  // keep 2 in flight
        if (!audio) break;
        await bubble?.remove();
        await client.sendVoiceBytes(dm, audio);
        sent++;
      } catch {
        await bubble?.remove();
        break;
      }
    }

    if (!sent && mode === 'voice') {
      await client.sendMarkdown(dm, say).catch(() => {});
    }
  }

  // ── input: voice, video notes, attachments, text ────────────────────────

  /** Transcribe an inbound voice or video note: download, react, transcribe.
   *  Returns the text or null when it couldn't be heard. */
  private async transcribeInbound(
    client: TelegramClient, dm: number, msg: any,
    file: { file_id: string; file_size?: number },
  ): Promise<string | null> {
    const react = (emoji?: string) => client.setMessageReaction(dm, msg.message_id, emoji).catch(() => {});
    if (file.file_size && file.file_size > MAX_INBOUND_BYTES) {
      await client.sendMessage(dm, "⚠️ That voice note is over Telegram's 20 MB limit for bots.");
      return null;
    }
    const apiKey = await this.deps.settings.credential('deepgram_api_key');
    if (!apiKey) { await client.sendMessage(dm, NOT_HEARD.no_key); return null; }
    const [, audio] = await Promise.all([react(REACT_TRANSCRIBING), client.downloadFile(file.file_id)])
      .catch(async (e) => { await react(); throw e; });
    const { voice_stt_model: sttModel, telegram_transcript_echo: echo } =
      await this.deps.settings.resolveMany(['voice_stt_model', 'telegram_transcript_echo']);
    const heard = await transcribeVoice(apiKey, audio, String(sttModel));
    if ('error' in heard) { await react(); await client.sendMessage(dm, NOT_HEARD[heard.error]); return null; }
    if (!heard.text) { await react(); await client.sendMessage(dm, "🎤 I couldn't make out any speech in that."); return null; }
    await react(REACT_HEARD);
    if (echo === true) await client.sendMessage(dm, `🎤 "${heard.text}"`);
    return heard.text;
  }

  private async resolveInput(client: TelegramClient, dm: number, msgs: any[],
    bot: TelegramBotStateRow): Promise<string | null> {
    const msg = msgs[0];
    // Telegram puts the caption on only one album item.
    const typed = msgs.map((m) => String(m.text ?? m.caption ?? '').trim()).find(Boolean) ?? '';

    // A voice note is the message itself (never `audio` — an mp3 is a file).
    if (msg.voice && !typed) return this.transcribeInbound(client, dm, msg, msg.voice);

    // A round video message (video_note) is treated like a voice note:
    // download, extract audio, transcribe.
    if (msg.video_note && !typed) return this.transcribeInbound(client, dm, msg, msg.video_note);

    // Everything else file-bearing: save to the session's scratch, describe it.
    // Attachments only land in code mode (there is a session's scratch to use).
    // Collect from ALL messages — an album sends each photo as a separate update.
    const files = msgs.flatMap(collectFiles);
    if (files.length) {
      if (bot.mode !== 'code' || !bot.activeSessionId) {
        await client.sendMessage(dm, "⚠️ Files go into the session you're coding in — /code to enter one first.");
        return typed || null;
      }
      const scratch = sessionDir(this.deps.paths, bot.activeSessionId) + '/scratch';
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

  // ── sent messages: reply-switch and reaction-speak ───────────────────────

  private async switchForReply(client: TelegramClient, dm: number, msg: any): Promise<void> {
    const replied = msg.reply_to_message;
    if (!replied?.message_id) return;
    const stored = await this.deps.sentMessages.get(dm, Number(replied.message_id));
    if (!stored) return;
    const bot = await this.deps.botState.read();
    if (stored.sessionId) {
      if (bot.activeSessionId === stored.sessionId && bot.mode === 'code') return;
      if (bot.activeSessionId !== stored.sessionId) {
        // The bubble goes with its session (cascade), so this only fails on a
        // delete racing the reply. A destroyed session keeps its row.
        const r = await this.switchSession(client, dm, stored.sessionId, { silent: true });
        if ('error' in r) { await client.sendMessage(dm, '⚠️ That session no longer exists.'); return; }
      }
      await this.enterMode(client, dm, 'code');
    } else {
      if (bot.mode === 'assistant') return;
      // The switch line is the whole message here.
      await this.enterMode(client, dm, 'assistant');
    }
  }

  // ── the two transitions: WHICH session, WHO answers ──────────────────────

  /** Point the bot at a session. The pointer only — the mode is untouched,
   *  so the assistant keeps the conversation and a coder is never entered by
   *  accident. Announces the switch unless `silent` — callers that immediately
   *  follow with enterMode('code') pass silent because the code-mode label
   *  already carries the session name. */
  async switchSession(client: TelegramClient, dm: number, id: string, opts?: { silent?: boolean }):
  Promise<{ id: string; title: string | null } | { error: string }> {
    const s = await this.deps.sessions.get(id);
    if (!s) return { error: `no session ${id}` };
    await this.deps.botState.setActiveSession(id);
    if (!opts?.silent) await client.sendMessage(dm, `🔀 Active session: ${s.name ?? 'untitled'}`);
    return { id, title: s.name ?? null };
  }

  /** Change who answers a plain message. Announces the transition iff the mode
   *  changed and swaps the chat's command menu to the mode's list. Returns
   *  whether the mode changed. Code mode presumes an active session — the
   *  caller checks (/code) or has just switched (a reply to a coder's bubble). */
  async enterMode(client: TelegramClient, dm: number, mode: TelegramMode): Promise<boolean> {
    const msg = mode === 'code'
      ? await this.codeModeLabel(dm)
      : undefined;
    const changed = await this.deps.botState.setMode(mode, (t) => client.sendMessage(dm, t), msg);
    await client.setMyCommands(menuFor(mode), dm).catch(() => {});
    return changed;
  }

  /** The short line sent when entering code mode — workspace prefix, card ID,
   *  session name, and (when switching) the last thing the agent said. One
   *  function, used by enterMode and the /code echo. Pass `dm` to include the
   *  last agent message (the switch announcement); omit it for a bare label. */
  async codeModeLabel(dm?: number): Promise<string> {
    const bot = await this.deps.botState.read();
    if (!bot.activeSessionId) return '🤖 Coding agent';
    const s = await this.deps.sessions.get(bot.activeSessionId);
    if (!s) return '🤖 Coding agent';
    const card = (await this.deps.cards.ofSession(bot.activeSessionId))?.number;
    const w = await this.deps.workspaces.get(s.workspaceId);
    const prefix = w ? await this.deps.workspaces.prefixOf(w) : undefined;
    const parts: string[] = ['🤖 Coding agent'];
    if (prefix) parts.push(prefix);
    if (prefix && card != null) parts.push(`${prefix}-${card}`);
    else if (card != null) parts.push(`#${card}`);
    parts.push(s.name ?? 'untitled');
    const title = parts.join(' · ');
    if (dm != null) {
      const last = await this.deps.sentMessages.lastForSession(dm, bot.activeSessionId).catch(() => null);
      if (last) return titled(title, last);
    }
    return title;
  }

  private async speakReacted(reaction: any, dm: number): Promise<void> {
    const chatId = Number(reaction.chat?.id);
    const messageId = Number(reaction.message_id);
    if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) return;
    const stored = await this.deps.sentMessages.get(chatId, messageId);
    if (!stored) return;
    const token = await this.token();
    const client = new TelegramClient(token);
    const apiKey = (await this.deps.settings.credential('deepgram_api_key')) ?? '';
    const voice = String(await this.deps.settings.resolve('voice_spoken_voice'));
    client.sendChatAction(dm, 'record_voice').catch(() => {});
    const audio = await speakVoice(apiKey, voice,
      stored.content.replace(/\n\n\(\d+\/\d+\)$/, '').slice(0, SPEAK_MAX_CHARS));
    if (audio) await client.sendVoiceBytes(chatId, audio, { replyToMessageId: messageId }).catch(() => {});
    else await client.sendMessage(chatId, "⚠️ I couldn't turn that into audio — check the Deepgram key.",
      { replyToMessageId: messageId }).catch(() => {});
  }

  // ── /stop and command support (used by commands.ts) ──────────────────────

  /** Stop the in-flight turn for the given key (a sessionId in code mode,
   *  'assistant' in assistant mode). Returns whether one was running. OUR
   *  turn only: stopping someone else's is the interrupt route's job, and
   *  commands.ts calls it for exactly that. */
  stop(key: string): boolean {
    const b = this.inFlight.get(key);
    if (!b) return false;
    b.queue.length = 0;
    b.abort.abort();
    return true;
  }

  get botState() { return this.deps.botState; }
  get settings() { return this.deps.settings; }
  get sessions() { return this.deps.sessions; }
  get workspaces() { return this.deps.workspaces; }
  get presets() { return this.deps.presets; }
  get system() { return this.deps.system; }

  /** Stop a turn on a session, from this bot: the engine's own turn (inFlight)
   *  and, through Sessions.interrupt, any other runner's. */
  interrupt(sessionId: string): void {
    this.stop(sessionId);
    this.deps.sessions.interrupt(sessionId, CLIENT_ID, { activeTurns: this.deps.activeTurns, foreground: this.deps.foreground });
  }

  /** The approval gate, for slash commands that need a confirm (today:
   *  /restart). Same gate gated tools use — one question per chat. */
  askApproval(client: TelegramClient, dm: number, ask: Ask): Promise<boolean> {
    return this.approvals.request(client, dm, ask);
  }

  /** `/auto_push` and `/auto_pull` — called directly (not through the HTTP
   *  route) so onStep fires live as each step completes. injectFetch buffers
   *  the full response before returning, which killed the progressive UI. */
  async autoPush(sessionId: string, onStep?: (label: string) => void): Promise<AutoPushOutcome> {
    return this.runSync('push', sessionId, AUTO_PUSH_STEPS, this.deps.autoPush, onStep);
  }
  async autoPull(sessionId: string, onStep?: (label: string) => void): Promise<AutoPullOutcome> {
    return this.runSync('pull', sessionId, AUTO_PULL_STEPS, this.deps.autoPull, onStep);
  }

  private async runSync<T extends AutoPushOutcome | AutoPullOutcome>(
    label: string,
    sessionId: string,
    steps: Record<string, string>,
    fn: ((s: SessionRow, w: WorkspaceRow, onEvent?: (e: { step: string; detail?: string }) => void | Promise<void>, by?: string) => Promise<T>) | undefined,
    onStep?: (label: string) => void,
  ): Promise<T> {
    if (!fn) return { result: 'error', reason: `auto-${label} is not available on this server` } as T;
    try {
      const session = await this.deps.sessions.get(sessionId);
      if (!session) return { result: 'error', reason: 'session not found' } as T;
      const workspace = await this.deps.workspaces.get(session.workspaceId);
      if (!workspace) return { result: 'error', reason: 'workspace not found' } as T;
      return await fn(session, workspace, (e) => {
        const text = steps[e.step] ?? e.step;
        const detail = e.detail ? ` — ${e.detail}` : '';
        onStep?.(`${text}${detail}`);
      }, CLIENT_ID);
    } catch (e) { return { result: 'error', reason: (e as Error).message } as T; }
  }

  private turnDeps(): TurnDeps {
    return { f: this.fetch, apiKey: this.deps.apiKey, base: BASE,
      modelFetch: this.deps.modelFetch, sessionEvents: this.deps.sessionEvents, client: CLIENT_ID,
      backdoor: this.deps.backdoor };
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

  /** The `send_message` tool's delivery (POST /sessions/:id/notify): one
   *  deliberate DM from a coding session, through the same sink a reply
   *  takes — so it arrives exactly as a reply would — recorded against the
   *  session so a reply to it enters the session. No waiting bubble: there
   *  is nothing to wait for. Throws with the reason when the bot is off or
   *  unconfigured; the route turns that into the tool's answer. */
  async notify(sessionId: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error('empty message');
    if (await this.deps.settings.resolve('telegram_enabled') !== true) throw new Error('telegram is off (/settings)');
    const dm = await this.authorizedUser();
    if (!dm) throw new Error('no telegram_authorized_user set (/settings)');
    const token = await this.token();
    if (!token) throw new Error('no telegram_bot_token stored (/keys)');
    const client = this.trackedClient(token, dm, () => sessionId);
    const sink = makeTelegramSink(client, dm, this.deliverConfig(sessionId), { voiceOnly: await this.voiceOnly(), bubble: false });
    const said = await sink.done(text);
    await this.maybeSpeak(client, dm, said);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

const TYPING_MS = 4000;
/** Keep an action showing for the whole turn, and let the caller change WHICH
 *  one. Telegram expires an action after ~5s, so it has to be re-sent on a
 *  timer — a one-off `record_voice` from elsewhere would be overwritten by the
 *  next `typing` tick. The switch belongs to the loop. */
function startTyping(client: TelegramClient, dm: number, initial = 'typing') {
  let action = initial;
  const ping = () => { client.sendChatAction(dm, action).catch(() => {}); };
  ping();
  const timer = setInterval(ping, TYPING_MS);
  return {
    /** Show something else from now on, immediately and on every later tick. */
    set(next: string) { action = next; ping(); },
    stop() { clearInterval(timer); },
  };
}

function hasEmoji(list: any, emoji: string): boolean {
  return Array.isArray(list) && list.some((r) => r?.type === 'emoji' && r?.emoji === emoji);
}

const MEDIA_FIELDS: Array<{ field: string; kind?: 'image' | 'video' | 'audio' }> = [
  { field: 'photo', kind: 'image' }, { field: 'document' },
  { field: 'video', kind: 'video' }, { field: 'video_note', kind: 'video' },
  { field: 'animation', kind: 'video' }, { field: 'audio', kind: 'audio' },
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
