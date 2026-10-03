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

import { CodingAgent } from '../../core/agents/coding.js';
import type { Settings, AgentConfig as SdkAgentConfig, ModelCatalog } from 'phantom-backend-sdk';
import type { FastifyInstance } from 'fastify';
import type { Paths } from 'phantom-backend-sdk';
import { sessionDir } from 'phantom-backend-sdk';
import { injectFetch } from '../looper/injectFetch.js';
import { runCodingTurn, type TurnDeps } from '../looper/turn.js';
import { oldAgentConfig } from '../agentConfig.js';
import { sessionPin } from '../agentConfig.js';
import type { SettingsEvents } from 'phantom-backend-sdk';
import { APP_VERSION } from 'phantom-backend-sdk';
import { openSession, SessionLockedError, type OpenedSession } from '../../core/session.js';
import type { Sessions } from 'phantom-backend-sdk';
import type { Cards } from 'phantom-backend-sdk';
import type { Presets } from 'phantom-backend-sdk';
import type { System } from 'phantom-backend-sdk';
import type { SessionEvents } from 'phantom-backend-sdk';
import type { UserMessageQueue } from 'phantom-backend-sdk';
import type { BoardEvents, BoardEvent } from 'phantom-backend-sdk';
import { autoBuildAlert } from './alerts.js';
import { logger, errStr } from 'phantom-backend-sdk';
import { TelegramApi, titled } from 'phantom-backend-sdk';
import { collectFiles, type TelegramBot } from 'phantom-backend-sdk';
import { runAssistantTurn, CLIENT_ID, type AssistantDeps } from './assistant.js';
import type { Ask } from 'phantom-backend-sdk';
import { UpgradeChecker } from 'phantom-backend-sdk';
import type { TelegramBotState, TelegramBotStateRow, TelegramMode } from 'phantom-backend-sdk';
import type { TelegramSentMessages } from 'phantom-backend-sdk';
import type { TelegramHandledUpdates } from 'phantom-backend-sdk';
import { menuFor, handleCommand } from './commands.js';
import { AUTO_PUSH_STEPS, AUTO_PULL_STEPS, type AutoPushOutcome, type AutoPullOutcome } from '../../core/llm/tools/git.js';
import type { AutoPushEvent, AutoPullEvent } from 'phantom-backend-sdk';
import type { SessionRow, ProjectRow } from 'phantom-backend-sdk/schema';
import type { Projects } from 'phantom-backend-sdk';
import { AssistantConversation } from './assistantConversation.js';


const log = logger('telegram');
const BASE = 'http://looper/api';

// Progress on a voice message itself. WRITTEN AS ESCAPES — Telegram's reaction
// set carries no variation selectors, and a picker-pasted glyph brings one,
// yielding REACTION_INVALID.


export interface TelegramAssistantBotDeps {
  /** The SDK's Telegram plumbing: the link, verified inbound, delivery. */
  bot: TelegramBot;
  /** Telegram's own rows — one owner per table (see each file). */
  botState: TelegramBotState;
  sentMessages: TelegramSentMessages;
  handledUpdates: TelegramHandledUpdates;
  settings: Settings;
  agentConfig: SdkAgentConfig;
  modelCatalog: ModelCatalog;
  sessions: Sessions;
  cards: Cards;
  projects: Projects;
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
  backdoor?: UserMessageQueue;
  modelFetch?: typeof fetch;
  /** https://PHANTOM_BACKEND_ADDRESS — the only source of the webhook URL. */
  publicAddress?: string;
  /** Direct auto-push / auto-pull — bypasses injectFetch so onEvent fires
   *  as each step completes instead of all at once after the stream ends. */
  autoPush?: (session: SessionRow, project: ProjectRow,
    onEvent?: (e: AutoPushEvent) => void | Promise<void>, by?: string) => Promise<AutoPushOutcome>;
  autoPull?: (session: SessionRow, project: ProjectRow,
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

export class TelegramAssistantBot {
  private fetch: typeof globalThis.fetch;
  private inFlight = new Map<string, InFlightTurn>();

  /** The Assistant's conversation — history, transcript, compaction. */
  readonly conversation: AssistantConversation;

  /** The upgrade checker — periodic GitHub release check + Telegram notification. */
  upgradeChecker: UpgradeChecker;

  constructor(private deps: TelegramAssistantBotDeps) {
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
      setting: (key) => deps.settings.resolve(key),
      token: () => this.deps.bot.token(),
      authorizedUser: () => this.deps.bot.authorizedUser(),
      makeClient: (token, dm) => this.deps.bot.clientForChat(token, dm, () => null),
    });
    // Every card write in the system, all projects; alerts.ts decides which
    // are the supervisor's moves. Fire-and-forget: an alert that fails is logged,
    // never retried, and never touches the card.
    deps.events?.subscribeAll((projectId, e) => {
      this.alert(projectId, e).catch((err) => log.warn({ err: errStr(err) }, 'auto build alert failed'));
    });
    // What the bot hands over: a verified message (an album as one), a tap
    // that is not an approval's (the upgrade's).
    deps.bot.onMessageReceived((dm, msgs) => this.handleMessage(dm, msgs));
    deps.bot.onButtonTapped(async (dm, query, api) => {
      if (UpgradeChecker.isUpgradeCallback(query.data)) await this.upgradeChecker.handleCallback(api, dm, query);
    });
  }

  /** The link as the settings say (the bot's). */
  reconcile(): Promise<void> { return this.deps.bot.reconcileLink(); }
  /** The webhook's body (the route's). */
  handleUpdate(secretHeader: string, update: unknown): Promise<number> { return this.deps.bot.receiveUpdate(secretHeader, update); }
  /** The send_message tool's delivery (the notification channel's). */
  notify(sessionId: string, text: string): Promise<void> { return this.deps.bot.sendMessageForSession(sessionId, text); }

  // ── auto build alerts ────────────────────────────────────────────────────

  /** One DM per loop move into in_progress / blocked / done, when
   *  `telegram_auto_build_notifications` resolves on for that project and
   *  the bot is enabled for an authorized user. The bubble is recorded with
   *  the card's coding session as its origin, so a reply to it enters that
   *  session in code mode like a reply to any coder bubble. */
  private async alert(projectId: string, e: BoardEvent): Promise<void> {
    if (e.event !== 'card' || !e.from || e.from === e.card.status) return;   // the cheap test first — no I/O
    const project = await this.deps.projects.get(projectId);
    if (!project) return;
    const alertMsg = autoBuildAlert(e, await this.deps.projects.prefixOf(project));
    if (!alertMsg) return;
    // The switch resolved at this project's layer.
    const s = await this.deps.settings.resolveMany(
      ['telegram_auto_build_notifications', 'telegram_enabled', 'telegram_authorized_user'], { projectId: project.id });
    if (s.telegram_auto_build_notifications !== true || s.telegram_enabled !== true) return;
    const dm = Number(s.telegram_authorized_user ?? '');
    if (!dm || !Number.isFinite(dm)) return;
    const token = await this.deps.bot.token();
    if (!token) return;
    const coder = await this.deps.sessions.coderOf(projectId, alertMsg.number);
    const client = this.deps.bot.clientForChat(token, dm, () => coder?.id ?? null);
    await client.sendMessage(dm, alertMsg.text);
    log.info({ project: projectId, card: alertMsg.number, status: alertMsg.status }, 'auto build alert sent');
  }

  // ── the turn ───────────────────────────────────────────────────────────────────────

  private async handleMessage(dm: number, msgs: any[]): Promise<void> {
    const msg = msgs[0];
    const token = await this.deps.bot.token();
    // Which conversation a sent bubble belongs to. A function so the tracked
    // client always records the CURRENT value — it moves from the assistant
    // (null) to a session once the bot state is read, and the closure follows.
    let sessionId: string | null = null;
    const client = this.deps.bot.clientForChat(token, dm, () => sessionId);

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
      if (this.deps.bot.answerApprovalByText(dm, input)) return;

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
  private async assistantTurn(client: TelegramApi, dm: number, message: string): Promise<void> {
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
    const sink = await this.deps.bot.startReplyBubble(client, dm, bot.activeSessionId ?? null);
    const deps: AssistantDeps = { f: this.fetch, apiKey: this.deps.apiKey, modelFetch: this.deps.modelFetch,
      cards: this.deps.cards, projects: this.deps.projects };
    let replyText = '';
    // The pointer as this turn sees it — live across a switch within the turn.
    let active = bot.activeSessionId ?? null;
    try {
      // The assistant's session row exists BEFORE its agent is built: the
      // turn runs on the row's model, its tools open the row's workspace, and
      // every call is billed to it.
      const own = await conv.ensureSession(bot.activeProjectId, bot.activeSessionId);
      const project = bot.activeProjectId ? await this.deps.projects.get(bot.activeProjectId) : undefined;
      const config = await oldAgentConfig(this.deps.agentConfig, this.deps.settings, 'assistant', project ? { projectId: project.id } : {}, sessionPin(own));
      conv.compaction = config.compaction;
      const onSwitch = async (id: string) => {
        const r = await this.switchSession(client, dm, id);
        if ('error' in r) return r;
        active = r.id;
        // The assistant's workspace follows the switch mid-turn: its read tools
        // open the row's workspace, so the very next call sees the new files.
        await this.deps.sessions.follow(own.id, bot.activeProjectId!, r.id);
        return { active: r.id, title: r.title,
          note: "You are still the assistant — this session's files are now what your read tools see. " +
            'The user sends /code to talk to its coding agent; you never enter it.' };
      };
      // A new project: make it active and open a session in it — what /new
      // does, so the user lands talking to the coder like the cli's "on screen".
      const onProjectCreated = async (projectId: string) => {
        await this.deps.botState.setActiveProject(projectId);
        let started;
        try { started = await this.deps.sessions.start(projectId, CodingAgent.systemPromptLayout, { startedBy: 'telegram' }); }
        catch (e) { return { error: (e as Error).message }; }
        await this.deps.botState.setActiveSession(started.id);
        await this.enterMode(client, dm, 'code');
        await client.sendMessage(dm, '🆕 New session in the new project. Send your first message to begin.');
        return { session: started.id };
      };
      const result = await runAssistantTurn(deps, conv.history, message, sink, {
        config,
        projectId: () => bot.activeProjectId ?? null,
        activeSession: () => active,
        onSwitch,
        approve: (ask, signal) => this.deps.bot.askForApproval(client, dm, ask, signal),
        onProjectCreated,
      }, abort.signal, conv.getTranscript(), own);
      replyText = result.said;
      await this.deps.sessions.turnEnded(own, CLIENT_ID).catch(
        (e) => log.warn({ err: errStr(e) }, 'assistant session update failed'));
      // Long chat? Summarize it in the background — turns never wait on it.
      conv.kickCompaction(result.usage.input);
      // Any messages queued while we ran go out as one follow-up turn.
      const queued = this.inFlight.get(busyKey)?.queue ?? [];
      this.inFlight.delete(busyKey);
      await this.deps.bot.speakText(client, dm, replyText, typing);
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
  private async codeTurn(client: TelegramApi, dm: number, sessionId: string, message: string): Promise<void> {
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
    const sink = await this.deps.bot.startReplyBubble(client, dm, sessionId);
    // The bubble reads the session feed — the ONE place a coding turn's parts
    // are published. Subscribe before the run; the lock makes this the only
    // turn on the session, so there is no gap. The same feed carries the stop
    // signal: an `interrupt` (esc-esc in a cli window, the interrupt route)
    // aborts this turn exactly as /stop does.
    const unsubscribe = this.deps.sessionEvents?.subscribe(sessionId, (e) => {
      if (e.event === 'part') sink.appendPart(e.part as Record<string, unknown>);
      else if (e.event === 'interrupt') abort.abort();
    });

    try {
      const s = await this.deps.sessions.get(sessionId);
      const projectId = s?.projectId ?? '';
      const planMode = s?.planMode === true;
      const project = s ? await this.deps.projects.get(s.projectId) : undefined;
      const cfg = await oldAgentConfig(this.deps.agentConfig, this.deps.settings, 'coding', project ? { projectId: project.id } : {}, sessionPin(opened.session));
      // `signal` is what makes the turn stoppable at all: /stop aborts this
      // controller through the inFlight map, a remote interrupt through the feed
      // subscription above — runCodingTurn ends it cleanly (interrupted, not
      // failed) either way.
      const deps: TurnDeps = { ...this.turnDeps(), signal: abort.signal };
      const r = await runCodingTurn(deps, opened, projectId, message, planMode, cfg);
      unsubscribe?.();
      const said = await sink.finish(r.text);
      const queued = this.inFlight.get(sessionId)?.queue ?? [];
      this.inFlight.delete(sessionId);
      await opened.close();
      await this.deps.bot.speakText(client, dm, said, typing);
      typing.stop();
      if (queued.length) await this.codeTurn(client, dm, sessionId, queued.join('\n\n'));
      return;
    } catch (e) {
      unsubscribe?.();
      await sink.discard();
      this.inFlight.delete(sessionId);
      await opened.close().catch(() => {});
      typing.stop();
      log.error({ err: errStr(e) }, 'code turn failed');
      await client.sendMessage(dm, `⚠️ ${(e as Error).message}`).catch(() => {});
    }
  }

  // ── input: voice, video notes, attachments, text ────────────────────────

  private async resolveInput(client: TelegramApi, dm: number, msgs: any[],
    bot: TelegramBotStateRow): Promise<string | null> {
    const msg = msgs[0];
    // Telegram puts the caption on only one album item.
    const typed = msgs.map((m) => String(m.text ?? m.caption ?? '').trim()).find(Boolean) ?? '';

    // A voice note is the message itself (never `audio` — an mp3 is a file).
    if (msg.voice && !typed) return this.deps.bot.transcribeVoiceNote(client, dm, msg, msg.voice);

    // A round video message (video_note) is treated like a voice note:
    // download, extract audio, transcribe.
    if (msg.video_note && !typed) return this.deps.bot.transcribeVoiceNote(client, dm, msg, msg.video_note);

    // Everything else file-bearing: save to the session's scratch, describe it.
    // Attachments only land in code mode (there is a session's scratch to use).
    // Collect from ALL messages — an album sends each photo as a separate update.
    const files = msgs.flatMap(collectFiles);
    if (files.length) {
      if (bot.mode !== 'code' || !bot.activeSessionId) {
        await client.sendMessage(dm, "⚠️ Files go into the session you're coding in — /code to enter one first.");
        return typed || null;
      }
      const described = await this.deps.bot.saveAttachmentsToSession(client, dm, msgs, bot.activeSessionId, typed);
      return described ?? (typed || null);
    }

    if (typed) return typed;
    await client.sendMessage(dm, "ℹ️ Send me a message, a voice note, or a file and I'll get to work.");
    return null;
  }

  // ── sent messages: reply-switch and reaction-speak ───────────────────────

  private async switchForReply(client: TelegramApi, dm: number, msg: any): Promise<void> {
    const repliedSession = await this.deps.bot.sessionOfRepliedMessage(dm, msg);
    if (repliedSession === undefined) return;
    const bot = await this.deps.botState.read();
    if (repliedSession) {
      if (bot.activeSessionId === repliedSession && bot.mode === 'code') return;
      if (bot.activeSessionId !== repliedSession) {
        // The bubble goes with its session (cascade), so this only fails on a
        // delete racing the reply. A destroyed session keeps its row.
        const r = await this.switchSession(client, dm, repliedSession, { silent: true });
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
  async switchSession(client: TelegramApi, dm: number, id: string, opts?: { silent?: boolean }):
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
  async enterMode(client: TelegramApi, dm: number, mode: TelegramMode): Promise<boolean> {
    const msg = mode === 'code'
      ? await this.codeModeLabel(dm)
      : undefined;
    const changed = await this.deps.botState.setMode(mode, (t) => client.sendMessage(dm, t), msg);
    await client.setMyCommands(menuFor(mode), dm).catch(() => {});
    return changed;
  }

  /** The short line sent when entering code mode — project prefix, card ID,
   *  session name, and (when switching) the last thing the agent said. One
   *  function, used by enterMode and the /code echo. Pass `dm` to include the
   *  last agent message (the switch announcement); omit it for a bare label. */
  async codeModeLabel(dm?: number): Promise<string> {
    const bot = await this.deps.botState.read();
    if (!bot.activeSessionId) return '🤖 Coding agent';
    const s = await this.deps.sessions.get(bot.activeSessionId);
    if (!s) return '🤖 Coding agent';
    const card = (await this.deps.cards.ofSession(bot.activeSessionId))?.number;
    const project = await this.deps.projects.get(s.projectId);
    const prefix = project ? await this.deps.projects.prefixOf(project) : undefined;
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
  get modelCatalog() { return this.deps.modelCatalog; }
  get sessions() { return this.deps.sessions; }
  get projects() { return this.deps.projects; }
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
  askApproval(client: TelegramApi, dm: number, ask: Ask): Promise<boolean> {
    return this.deps.bot.askForApproval(client, dm, ask);
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
    fn: ((s: SessionRow, project: ProjectRow, onEvent?: (e: { step: string; detail?: string }) => void | Promise<void>, by?: string) => Promise<T>) | undefined,
    onStep?: (label: string) => void,
  ): Promise<T> {
    if (!fn) return { result: 'error', reason: `auto-${label} is not available on this server` } as T;
    try {
      const session = await this.deps.sessions.get(sessionId);
      if (!session) return { result: 'error', reason: 'session not found' } as T;
      const project = await this.deps.projects.get(session.projectId);
      if (!project) return { result: 'error', reason: 'project not found' } as T;
      return await fn(session, project, (e) => {
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

}

// ── helpers ────────────────────────────────────────────────────────────────

const TYPING_MS = 4000;
/** Keep an action showing for the whole turn, and let the caller change WHICH
 *  one. Telegram expires an action after ~5s, so it has to be re-sent on a
 *  timer — a one-off `record_voice` from elsewhere would be overwritten by the
 *  next `typing` tick. The switch belongs to the loop. */
function startTyping(client: TelegramApi, dm: number, initial = 'typing') {
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

