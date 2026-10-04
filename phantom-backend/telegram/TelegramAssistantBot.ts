// The Telegram bot's BEHAVIOUR: modes, commands, which turn to run, alerts —
// on the SDK's TelegramBot (the link, verified inbound, delivery) and the
// client SDK's agents over loopback. One authorized user, DM-only, webhook. Two modes on one sticky
// bot state row: ASSISTANT (home — the Assistant answers, board/cards/sessions)
// and CODE (inside a session — a plain message runs a coding turn on it).
//
// Design is phantom-looper's, not shockwave's: sessions are explicit and
// long-lived (no lazy chat minting, no per-message checkout prep), the
// Assistant is the primary agent, work lands only through /auto_push, and voice
// is Deepgram-only. Mechanisms (the streaming bubble, entities, telegram_sent_messages,
// attachments, the escape-spelled reactions) are ported from ../shockwave.

import { CodingAgent } from '../../core/agents/coding.js';
import { AssistantAgent } from '../../core/agents/assistant.js';
import { BackendClient, type Agent, type AgentHandlers } from 'phantom-client-sdk';
import { telegramAssistantKit, CLIENT_ID, TELEGRAM_STARTER } from './assistant.js';
import type { FastifyInstance } from 'fastify';
import { APP_VERSION } from 'phantom-backend-sdk';
import type { Deployment, PhantomBackend } from 'phantom-backend-sdk';
import type { BoardEvent } from 'phantom-backend-sdk';
import type { SessionRow, ProjectRow } from 'phantom-backend-sdk/schema';
import { autoBuildAlert } from './alerts.js';
import { logger, errStr } from 'phantom-backend-sdk';
import { TelegramApi, titled } from 'phantom-backend-sdk';
import { collectFiles } from 'phantom-backend-sdk';
import type { Ask } from 'phantom-backend-sdk';
import { UpgradeChecker } from 'phantom-backend-sdk';
import type { TelegramBotStateRow, TelegramMode } from 'phantom-backend-sdk';
import { menuFor, handleCommand } from './commands.js';
import { AUTO_PUSH_STEPS, AUTO_PULL_STEPS, type AutoPushOutcome, type AutoPullOutcome } from '../../core/agents/assistant/gitSteps.js';


const log = logger('telegram');
const BASE = 'http://looper/api';

// Progress on a voice message itself. WRITTEN AS ESCAPES — Telegram's reaction
// set carries no variation selectors, and a picker-pasted glyph brings one,
// yielding REACTION_INVALID.


/** A turn in flight on THIS bot, keyed per session (code mode) or
 *  'assistant'. A second message to the SAME key is queued and sent as one
 *  follow-up turn (the cli's queue shape); a message to a DIFFERENT key
 *  starts its own turn — so multiple sessions can run concurrently. /stop
 *  interrupts the agent; a remote interrupt reaches it over the session feed
 *  the agent itself listens to. */
interface InFlightTurn { queue: string[]; agent: Agent }

export class TelegramAssistantBot {
  private inFlight = new Map<string, InFlightTurn>();
  /** One client, this bot's lock identity, for every agent it opens. */
  private readonly client: BackendClient;


  /** The upgrade checker — periodic GitHub release check + Telegram notification. */
  readonly upgradeChecker: UpgradeChecker;

  /** On the backend's objects — its Telegram plumbing (the link, verified
   *  inbound, delivery), the bot-state row, the sessions, the board, the
   *  settings, its git — plus this app's `deployment` (update, logs, restart)
   *  and the looper's count of card runs in flight (the upgrade's health line). */
  constructor(readonly backend: PhantomBackend, readonly deployment: Deployment, private readonly loopsRunning: () => number) {
    this.client = new BackendClient({ url: backend.loopback.url, apiKey: backend.loopback.apiKey, clientId: CLIENT_ID, label: 'telegram', actor: TELEGRAM_STARTER });
    this.upgradeChecker = new UpgradeChecker({
      version: APP_VERSION,
      health: async () => ({ version: APP_VERSION, loops_running: loopsRunning() }),
      triggerUpdate: async (tag, onEvent) => {
        // restart_anyway: the approval DM already warns that running turns
        // are stopped and loop cards blocked — a tap on Approve is the
        // informed yes the update guard asks for.
        try {
          let last: string | undefined;
          await deployment.update(tag, { restartAnyway: true }, (event) => { last = event.event; onEvent?.(event); }).done;
          return last === 'error' ? { ok: false, error: 'update failed' } : { ok: true };
        } catch (error) { return { ok: false, error: (error as Error).message }; }
      },
      setting: (key) => backend.settings.resolve(key),
      token: () => this.backend.telegramBot.token(),
      authorizedUser: () => this.backend.telegramBot.authorizedUser(),
      makeClient: (token, chatId) => this.backend.telegramBot.clientForChat(token, chatId, () => null),
    });
    // Every card write in the system, all projects; alerts.ts decides which
    // are the supervisor's moves. Fire-and-forget: an alert that fails is logged,
    // never retried, and never touches the card.
    backend.boardEvents.subscribeAll((projectId, event) => {
      this.alert(projectId, event).catch((err) => log.warn({ err: errStr(err) }, 'auto build alert failed'));
    });
    // What the bot hands over: a verified message (an album as one), a tap
    // that is not an approval's (the upgrade's).
    backend.telegramBot.onMessageReceived((chatId, msgs) => this.handleMessage(chatId, msgs));
    backend.telegramBot.onButtonTapped(async (chatId, query, api) => {
      if (UpgradeChecker.isUpgradeCallback(query.data)) await this.upgradeChecker.handleCallback(api, chatId, query);
    });
  }

  /** The link as the settings say (the bot's). */
  reconcile(): Promise<void> { return this.backend.telegramBot.reconcileLink(); }
  /** The webhook's body (the route's). */
  handleUpdate(secretHeader: string, update: unknown): Promise<number> { return this.backend.telegramBot.receiveUpdate(secretHeader, update); }
  /** The send_message tool's delivery (the notification channel's). */
  notify(sessionId: string, text: string): Promise<void> { return this.backend.telegramBot.sendMessageForSession(sessionId, text); }

  // ── auto build alerts ────────────────────────────────────────────────────

  /** One DM per loop move into in_progress / blocked / done, when
   *  `telegram_auto_build_notifications` resolves on for that project and
   *  the bot is enabled for an authorized user. The bubble is recorded with
   *  the card's coding session as its origin, so a reply to it enters that
   *  session in code mode like a reply to any coder bubble. */
  private async alert(projectId: string, event: BoardEvent): Promise<void> {
    if (event.event !== 'card' || !event.from || event.from === event.card.status) return;   // the cheap test first — no I/O
    const project = await this.backend.projects.get(projectId);
    if (!project) return;
    const alertMsg = autoBuildAlert(event, await this.backend.projects.prefixOf(project));
    if (!alertMsg) return;
    // The switch resolved at this project's layer.
    const values = await this.backend.settings.resolveMany(
      ['telegram_auto_build_notifications', 'telegram_enabled', 'telegram_authorized_user'], { projectId: project.id });
    if (values.telegram_auto_build_notifications !== true || values.telegram_enabled !== true) return;
    const chatId = Number(values.telegram_authorized_user ?? '');
    if (!chatId || !Number.isFinite(chatId)) return;
    const token = await this.backend.telegramBot.token();
    if (!token) return;
    const coder = await this.backend.sessions.coderOf(projectId, alertMsg.number);
    const client = this.backend.telegramBot.clientForChat(token, chatId, () => coder?.id ?? null);
    await client.sendMessage(chatId, alertMsg.text);
    log.info({ project: projectId, card: alertMsg.number, status: alertMsg.status }, 'auto build alert sent');
  }

  // ── the turn ───────────────────────────────────────────────────────────────────────

  private async handleMessage(chatId: number, msgs: any[]): Promise<void> {
    const msg = msgs[0];
    const token = await this.backend.telegramBot.token();
    // Which conversation a sent bubble belongs to. A function so the tracked
    // client always records the CURRENT value — it moves from the assistant
    // (null) to a session once the bot state is read, and the closure follows.
    let sessionId: string | null = null;
    const client = this.backend.telegramBot.clientForChat(token, chatId, () => sessionId);

    try {
      // Show life immediately — before resolveInput (voice download +
      // transcription can take 1-3s) so the user never stares at nothing.
      client.sendChatAction(chatId, 'typing').catch(() => {});

      // A reply to one of my bubbles switches conversation BEFORE anything
      // reads which mode this is — commands included. Telegram puts the reply
      // on whichever album item carried it, so check all of them.
      for (const message of msgs) await this.switchForReply(client, chatId, message);

      // Typed text: Telegram puts the caption on only one album item.
      const typed = msgs.map((message) => String(message.text ?? message.caption ?? '').trim()).find(Boolean) ?? '';
      if (typed.startsWith('/')) {
        await handleCommand(this, client, chatId, typed);
        return;
      }

      const bot = await this.backend.telegramBotState.read();
      sessionId = bot.mode === 'code' ? bot.activeSessionId : null;

      const input = await this.resolveInput(client, chatId, msgs, bot);
      if (input === null) return;

      // A question standing: the exact word answers it and is nothing else;
      // any other message declines it and goes on to queue as the follow-up.
      if (this.backend.telegramBot.answerApprovalByText(chatId, input)) return;

      // Busy: queue the message into the SAME key's running turn. Code-mode
      // turns key by sessionId, so switching sessions starts independently;
      // the assistant is one conversation, so it stays one key.
      const busyKey = bot.mode === 'code' && bot.activeSessionId
        ? bot.activeSessionId : 'assistant';
      const running = this.inFlight.get(busyKey);
      if (running) {
        running.queue.push(input);
        await client.sendMessage(chatId, '⌛ Got it — after this turn.', { replyToMessageId: msg.message_id });
        return;
      }

      if (bot.mode === 'code' && bot.activeSessionId) {
        await this.codeTurn(client, chatId, bot.activeSessionId, input);
      } else {
        await this.assistantTurn(client, chatId, input);
      }
    } catch (error) {
      await client.sendMarkdown(chatId, titled('⚠️ Something went wrong', (error as Error).message)).catch(() => {});
      throw error;
    }
  }

  /** An assistant-mode turn: the Assistant's own session (its record IS the
   *  conversation), on the client SDK, streamed to the bubble. session_switch
   *  moves the active-session POINTER only — the assistant keeps the
   *  conversation; /code is how the user hands it over. */
  private async assistantTurn(client: TelegramApi, chatId: number, message: string): Promise<void> {
    const typing = startTyping(client, chatId);
    const busyKey = 'assistant';
    const bot = await this.backend.telegramBotState.read();
    // The assistant can deliver a file it names from the active session's work
    // dir (its file tools are read-only, but it can point at one the coder made).
    const sink = await this.backend.telegramBot.startReplyBubble(client, chatId, bot.activeSessionId ?? null);
    // The pointer as this turn sees it — live across a switch within the turn.
    let active = bot.activeSessionId ?? null;
    let agent: AssistantAgent | undefined;
    try {
      // The assistant's session row exists BEFORE its agent is built: the turn
      // runs on the row's model, its tools open the row's workspace, every call is billed to it.
      const own = await this.ensureAssistantSession(bot.activeProjectId, bot.activeSessionId);
      agent = await AssistantAgent.resumeSession(this.client, this.agentHandlers('assistant'), own.id);
      this.inFlight.set(busyKey, { queue: [], agent });
      const onSwitch = async (id: string) => {
        const switched = await this.switchSession(client, chatId, id);
        if ('error' in switched) return switched;
        active = switched.id;
        // The assistant's workspace follows the switch mid-turn: its read tools
        // open the row's workspace, so the very next call sees the new files.
        await agent!.follow(bot.activeProjectId!, switched.id);
        return { active: switched.id, title: switched.title,
          note: "You are still the assistant — this session's files are now what your read tools see. " +
            'The user sends /code to talk to its coding agent; you never enter it.' };
      };
      // A new project: make it active and open a session in it — what /new
      // does, so the user lands talking to the coder like the cli's "on screen".
      const onProjectCreated = async (projectId: string) => {
        await this.backend.telegramBotState.setActiveProject(projectId);
        let started;
        try { started = await this.backend.sessions.start(projectId, CodingAgent.systemPromptLayout, { type: 'coding', startedBy: TELEGRAM_STARTER }); }
        catch (error) { return { error: (error as Error).message }; }
        await this.backend.telegramBotState.setActiveSession(started.id);
        await this.enterMode(client, chatId, 'code');
        await client.sendMessage(chatId, '🆕 New session in the new project. Send your first message to begin.');
        return { session: started.id };
      };
      agent.addToolKit(telegramAssistantKit(
        { cards: this.backend.cards, projects: this.backend.projects, loopback: this.backend.loopback },
        { projectId: () => bot.activeProjectId ?? null, activeSession: () => active, onSwitch,
          approve: (ask, signal) => this.backend.telegramBot.askForApproval(client, chatId, ask, signal), onProjectCreated }));
      const off = agent.on('part', (part) => sink.appendPart(part as Record<string, unknown>));
      let result;
      try { result = await agent.sendMessage(message); } finally { off(); }
      const said = await sink.finish(result?.text ?? '');
      // Any messages queued while we ran go out as one follow-up turn.
      const queued = this.inFlight.get(busyKey)?.queue ?? [];
      this.inFlight.delete(busyKey);
      await agent.close();
      await this.backend.telegramBot.speakText(client, chatId, said, typing);
      typing.stop();
      if (queued.length) await this.assistantTurn(client, chatId, queued.join('\n\n'));
    } catch (error) {
      this.inFlight.delete(busyKey);
      await agent?.close().catch(() => {});
      sink.discard();
      typing.stop();
      const msg = (error as Error).message;
      const isPromptTooLong = /prompt is too long|request too large|context_too_long/i.test(msg);
      log.error({ err: errStr(error) }, 'assistant turn failed');
      await client.sendMessage(chatId, isPromptTooLong
        ? '⚠️ Chat history exceeds the model\'s limit.'
        : `⚠️ ${msg}`).catch(() => {});
    }
  }

  /** The assistant's session row, pointed at what the user is looking at:
   *  made on first use, re-pointed on every turn (Sessions.repoint). */
  private assistantSessionId: string | null = null;
  private async ensureAssistantSession(projectId: string | null, activeSessionId?: string | null): Promise<{ id: string }> {
    if (!projectId) throw new Error('no active project — /projects to pick one');
    if (this.assistantSessionId) {
      await this.backend.sessions.repoint(this.assistantSessionId, projectId, activeSessionId);
      const row = await this.backend.sessions.get(this.assistantSessionId);
      if (row) return row;
      this.assistantSessionId = null; // purged underneath us — make a new one
    }
    const row = await this.backend.sessions.start(projectId, AssistantAgent.systemPromptLayout,
      { type: 'assistant', startedBy: TELEGRAM_STARTER, workspaceSessionId: activeSessionId });
    this.assistantSessionId = row.id;
    return row;
  }

  /** A code-mode turn: the coding agent on its session, on the client SDK,
   *  streamed into the bubble. A session held elsewhere is refused with a
   *  note; an interrupt from anywhere (esc-esc in a cli window, the
   *  interrupt route, /stop) ends the turn cleanly. */
  private async codeTurn(client: TelegramApi, chatId: number, sessionId: string, message: string): Promise<void> {
    const typing = startTyping(client, chatId);
    const sink = await this.backend.telegramBot.startReplyBubble(client, chatId, sessionId);
    let agent: CodingAgent | undefined;
    try {
      agent = await CodingAgent.resumeSession(this.client, this.agentHandlers('coding'), sessionId);
      this.inFlight.set(sessionId, { queue: [], agent });
      const off = agent.on('part', (part) => sink.appendPart(part as Record<string, unknown>));
      let result;
      try { result = await agent.sendMessage(message); }
      catch (error) {
        if ((error as { code?: string }).code === 'session_locked') {
          off(); sink.discard(); this.inFlight.delete(sessionId); await agent.close(); typing.stop();
          const session = await this.backend.sessions.get(sessionId);
          await client.sendMessage(chatId, `🔒 That session is busy${session?.lockedLabel ? ` (${session.lockedLabel})` : ''} — try again in a moment.`);
          return;
        }
        throw error;
      } finally { off(); }
      const said = await sink.finish(result?.text ?? '');
      const queued = this.inFlight.get(sessionId)?.queue ?? [];
      this.inFlight.delete(sessionId);
      await agent.close();
      await this.backend.telegramBot.speakText(client, chatId, said, typing);
      typing.stop();
      if (queued.length) await this.codeTurn(client, chatId, sessionId, queued.join('\n\n'));
    } catch (error) {
      sink.discard();
      this.inFlight.delete(sessionId);
      await agent?.close().catch(() => {});
      typing.stop();
      log.error({ err: errStr(error) }, 'code turn failed');
      await client.sendMessage(chatId, `⚠️ ${(error as Error).message}`).catch(() => {});
    }
  }

  /** What an agent this bot runs tells it: errors and notices go to the log. */
  private agentHandlers(seat: 'coding' | 'assistant'): AgentHandlers {
    return {
      onError: (error) => log.warn({ agent: seat, code: error.code, err: error.message }, 'agent error'),
      onNotice: (notice) => log.info({ agent: seat, type: notice.type }, notice.text),
    };
  }

  // ── input: voice, video notes, attachments, text ────────────────────────

  private async resolveInput(client: TelegramApi, chatId: number, msgs: any[],
    bot: TelegramBotStateRow): Promise<string | null> {
    const msg = msgs[0];
    // Telegram puts the caption on only one album item.
    const typed = msgs.map((message) => String(message.text ?? message.caption ?? '').trim()).find(Boolean) ?? '';

    // A voice note is the message itself (never `audio` — an mp3 is a file).
    if (msg.voice && !typed) return this.backend.telegramBot.transcribeVoiceNote(client, chatId, msg, msg.voice);

    // A round video message (video_note) is treated like a voice note:
    // download, extract audio, transcribe.
    if (msg.video_note && !typed) return this.backend.telegramBot.transcribeVoiceNote(client, chatId, msg, msg.video_note);

    // Everything else file-bearing: save to the session's scratch, describe it.
    // Attachments only land in code mode (there is a session's scratch to use).
    // Collect from ALL messages — an album sends each photo as a separate update.
    const files = msgs.flatMap(collectFiles);
    if (files.length) {
      if (bot.mode !== 'code' || !bot.activeSessionId) {
        await client.sendMessage(chatId, "⚠️ Files go into the session you're coding in — /code to enter one first.");
        return typed || null;
      }
      const described = await this.backend.telegramBot.saveAttachmentsToSession(client, chatId, msgs, bot.activeSessionId, typed);
      return described ?? (typed || null);
    }

    if (typed) return typed;
    await client.sendMessage(chatId, "ℹ️ Send me a message, a voice note, or a file and I'll get to work.");
    return null;
  }

  // ── sent messages: reply-switch and reaction-speak ───────────────────────

  private async switchForReply(client: TelegramApi, chatId: number, msg: any): Promise<void> {
    const repliedSession = await this.backend.telegramBot.sessionOfRepliedMessage(chatId, msg);
    if (repliedSession === undefined) return;
    const bot = await this.backend.telegramBotState.read();
    if (repliedSession) {
      if (bot.activeSessionId === repliedSession && bot.mode === 'code') return;
      if (bot.activeSessionId !== repliedSession) {
        // The bubble goes with its session (cascade), so this only fails on a
        // delete racing the reply. A destroyed session keeps its row.
        const switched = await this.switchSession(client, chatId, repliedSession, { silent: true });
        if ('error' in switched) { await client.sendMessage(chatId, '⚠️ That session no longer exists.'); return; }
      }
      await this.enterMode(client, chatId, 'code');
    } else {
      if (bot.mode === 'assistant') return;
      // The switch line is the whole message here.
      await this.enterMode(client, chatId, 'assistant');
    }
  }

  // ── the two transitions: WHICH session, WHO answers ──────────────────────

  /** Point the bot at a session. The pointer only — the mode is untouched,
   *  so the assistant keeps the conversation and a coder is never entered by
   *  accident. Announces the switch unless `silent` — callers that immediately
   *  follow with enterMode('code') pass silent because the code-mode label
   *  already carries the session name. */
  async switchSession(client: TelegramApi, chatId: number, id: string, opts?: { silent?: boolean }):
  Promise<{ id: string; title: string | null } | { error: string }> {
    const session = await this.backend.sessions.get(id);
    if (!session) return { error: `no session ${id}` };
    await this.backend.telegramBotState.setActiveSession(id);
    if (!opts?.silent) await client.sendMessage(chatId, `🔀 Active session: ${session.name ?? 'untitled'}`);
    return { id, title: session.name ?? null };
  }

  /** Change who answers a plain message. Announces the transition iff the mode
   *  changed and swaps the chat's command menu to the mode's list. Returns
   *  whether the mode changed. Code mode presumes an active session — the
   *  caller checks (/code) or has just switched (a reply to a coder's bubble). */
  async enterMode(client: TelegramApi, chatId: number, mode: TelegramMode): Promise<boolean> {
    const msg = mode === 'code'
      ? await this.codeModeLabel(chatId)
      : undefined;
    const changed = await this.backend.telegramBotState.setMode(mode, (text) => client.sendMessage(chatId, text), msg);
    await client.setMyCommands(menuFor(mode), chatId).catch(() => {});
    return changed;
  }

  /** The short line sent when entering code mode — project prefix, card ID,
   *  session name, and (when switching) the last thing the agent said. One
   *  function, used by enterMode and the /code echo. Pass `dm` to include the
   *  last agent message (the switch announcement); omit it for a bare label. */
  async codeModeLabel(chatId?: number): Promise<string> {
    const bot = await this.backend.telegramBotState.read();
    if (!bot.activeSessionId) return '🤖 Coding agent';
    const session = await this.backend.sessions.get(bot.activeSessionId);
    if (!session) return '🤖 Coding agent';
    const card = (await this.backend.cards.ofSession(bot.activeSessionId))?.number;
    const project = await this.backend.projects.get(session.projectId);
    const prefix = project ? await this.backend.projects.prefixOf(project) : undefined;
    const parts: string[] = ['🤖 Coding agent'];
    if (prefix) parts.push(prefix);
    if (prefix && card != null) parts.push(`${prefix}-${card}`);
    else if (card != null) parts.push(`#${card}`);
    parts.push(session.name ?? 'untitled');
    const title = parts.join(' · ');
    if (chatId != null) {
      const last = await this.backend.telegramBot.lastMessageForSession(chatId, bot.activeSessionId);
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
    b.agent.interrupt({ keepQueue: true });
    return true;
  }

  /** Stop a turn on a session, from this bot: the bot's own turn (inFlight)
   *  and, through Sessions.interrupt, any other runner's. */
  interrupt(sessionId: string): void {
    this.stop(sessionId);
    this.backend.sessions.interrupt(sessionId, CLIENT_ID, { foreground: this.backend.foregroundCommands });
  }

  /** The approval gate, for slash commands that need a confirm (today:
   *  /restart). Same gate gated tools use — one question per chat. */
  askApproval(client: TelegramApi, chatId: number, ask: Ask): Promise<boolean> {
    return this.backend.telegramBot.askForApproval(client, chatId, ask);
  }

  /** `/auto_push` and `/auto_pull` — the backend's git called directly (not
   *  through the HTTP route) so onStep fires live as each step completes. */
  async autoPush(sessionId: string, onStep?: (label: string) => void): Promise<AutoPushOutcome> {
    return this.runSync('push', sessionId, AUTO_PUSH_STEPS, this.backend.git.autoPush, onStep);
  }
  async autoPull(sessionId: string, onStep?: (label: string) => void): Promise<AutoPullOutcome> {
    return this.runSync('pull', sessionId, AUTO_PULL_STEPS, this.backend.git.autoPull, onStep);
  }

  private async runSync<T extends AutoPushOutcome | AutoPullOutcome>(
    label: string,
    sessionId: string,
    steps: Record<string, string>,
    sync: ((session: SessionRow, project: ProjectRow, onEvent?: (step: { step: string; detail?: string }) => void | Promise<void>, by?: string) => Promise<T>) | undefined,
    onStep?: (label: string) => void,
  ): Promise<T> {
    if (!sync) return { result: 'error', reason: `auto-${label} is not available on this server` } as T;
    try {
      const session = await this.backend.sessions.get(sessionId);
      if (!session) return { result: 'error', reason: 'session not found' } as T;
      const project = await this.backend.projects.get(session.projectId);
      if (!project) return { result: 'error', reason: 'project not found' } as T;
      return await sync(session, project, (step) => {
        const text = steps[step.step] ?? step.step;
        const detail = step.detail ? ` — ${step.detail}` : '';
        onStep?.(`${text}${detail}`);
      }, CLIENT_ID);
    } catch (error) { return { result: 'error', reason: (error as Error).message } as T; }
  }


}

// ── helpers ────────────────────────────────────────────────────────────────

const TYPING_MS = 4000;
/** Keep an action showing for the whole turn, and let the caller change WHICH
 *  one. Telegram expires an action after ~5s, so it has to be re-sent on a
 *  timer — a one-off `record_voice` from elsewhere would be overwritten by the
 *  next `typing` tick. The switch belongs to the loop. */
function startTyping(client: TelegramApi, chatId: number, initial = 'typing') {
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

