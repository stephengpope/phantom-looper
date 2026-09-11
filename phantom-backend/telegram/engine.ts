// The Telegram engine: the bot as a client of this server. Started after
// listen (like the looper), reaching the routes through injectFetch. One
// authorized user, DM-only, webhook (never polling). Two modes on one sticky
// account row: ASSISTANT (home — the Assistant answers, board/cards/sessions)
// and CODE (inside a session — a plain message runs a coding turn on it).
//
// Design is phantom-looper's, not shockwave's: sessions are explicit and
// long-lived (no lazy chat minting, no per-message checkout prep), the
// Assistant is the primary agent, work lands only through /auto_push, and voice
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
import { getSession, currentLoop, loopOf, createAssistantSession, addSessionUsage, updateSessionPointers } from '../sessions.js';
import { resolveCredential } from '../settings.js';
import type { SessionEvents } from '../api/sessionEvents.js';
import type { BackdoorQueue } from '../api/backdoor.js';
import type { BoardEvents, BoardEvent } from '../api/boardEvents.js';
import { autoBuildAlert } from './alerts.js';
import { logger, errStr } from '../log.js';
import { TelegramClient, ALLOWED_UPDATES, titled } from './client.js';
import { makeTelegramSink, type DeliverConfig } from './sink.js';
import { startWaitingBubble } from './bubble.js';
import { sendMessageTool } from './sendMessageTool.js';
import { transcribeVoice, speakVoice, splitForSpeech, SPEAK_MAX_CHARS, type Transcription } from './deepgram.js';
import { writeAttachment, composeMessage, MAX_INBOUND_BYTES, type StoredAttachment } from './attachments.js';
import { runAssistantTurn, type AssistantDeps } from './assistant.js';
import { agentModelConfig } from '../../core/llm/agentConfig.js';
import { assistantInstructions } from '../../core/llm/agents/assistant.js';
import { loadTranscriptFile, newestTranscriptFile, Transcript, transcriptStamp } from '../../core/llm/transcript.js';
import { createCompactor, DEFAULT_HISTORY_LIMIT, type Compactor } from '../../core/llm/compaction.js';
import { Approvals, type Ask } from './approvals.js';
import { UpgradeChecker } from './upgrade.js';
import * as store from './store.js';
import { menuFor, handleCommand } from './commands.js';
import { autoPushSession, autoPullSession, type AutoPushOutcome, type AutoPullOutcome } from '../../core/llm/tools/git.js';


const log = logger('telegram');
const BASE = 'http://looper';
const CLIENT_ID = 'telegram';

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
  /** The board bus — the auto build alerts listen on it (alerts.ts). */
  events?: BoardEvents;
  /** The backdoor message queue (api/backdoor.ts) — each turn drains its
   *  session's queue. */
  backdoor?: BackdoorQueue;
  modelFetch?: typeof fetch;
  /** https://PHANTOM_BACKEND_ADDRESS — the only source of the webhook URL. */
  publicAddress?: string;
}

/** A turn in flight on THIS server, keyed per session (code mode) or
 *  'assistant'. A second message to the SAME key is queued and sent as one
 *  follow-up turn (the cli's queue shape); a message to a DIFFERENT key
 *  starts its own turn — so multiple sessions can run concurrently. A code
 *  turn's AbortController rides into runCodingTurn and is aborted two ways:
 *  /stop through this map, a remote interrupt through the turn's feed
 *  subscription; the assistant's stop is local (it is not a session). */
interface Busy { queue: string[]; abort: AbortController }

export class TelegramEngine {
  private f: typeof fetch;
  private busy = new Map<string, Busy>();
  /** Album debounce: Telegram sends multi-photo sends as separate updates
   *  sharing a `media_group_id`. A short timer collects them and runs once. */
  private albums = new Map<string, { msgs: any[]; timer: NodeJS.Timeout }>();
  /** The Assistant's ONE conversation — backed by the newest transcript file
   *  in assistantDir, loaded back on the first turn after a boot. */
  private assistantHistory: ModelMessage[] = [];
  private assistantTranscript: Transcript | null = null;
  private assistantLoaded = false;
  /** The assistant's session row id — created on first turn, rolled on
   *  compaction. Token usage accumulates on this row. */
  private assistantSessionId: string | null = null;
  /** The last turn's settings read and chat — the compactor's model/limit
   *  source and where the compaction notice goes. */
  private assistantValues: Record<string, unknown> = {};
  private assistantChat: { client: TelegramClient; dm: number } | null = null;
  /** The background compactor (core/llm/compaction.ts), kicked after every
   *  assistant turn. A failed summary is logged and retried after a later
   *  turn — the history is never dropped without one. */
  private compactor: Compactor = createCompactor({
    model: () => agentModelConfig(this.assistantValues, 'assistant'),
    limit: () => {
      const n = Number(this.assistantValues.assistant_history_limit);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_HISTORY_LIMIT;
    },
    onCompacted: () => this.onAssistantCompacted(),
    onFailed: (err) => log.warn({ err: err.message }, 'assistant compaction failed — will retry after a later turn'),
  });

  /** The Assistant's transcript directory: one live file (the newest), older
   *  ones the archive compaction left behind. Under the data root, outside
   *  any session's work dir — the Assistant is not a session. */
  private assistantDir(): string {
    return path.join(this.deps.paths.root, 'assistant');
  }

  /** The live transcript, created on first write. The header names the
   *  current assistant model best-effort — it records what wrote the file. */
  private transcript(): Transcript {
    if (!this.assistantTranscript) {
      let provider = 'unknown', model = 'unknown';
      try {
        const c = agentModelConfig(this.assistantValues, 'assistant');
        provider = c.provider; model = c.model;
      } catch { /* no model configured yet — the header says unknown */ }
      this.assistantTranscript = new Transcript({
        type: 'session', agent: 'assistant', provider, model,
        created_at: new Date().toISOString(), system_prompt: assistantInstructions(),
      }, path.join(this.assistantDir(), `${transcriptStamp()}.jsonl`));
    }
    return this.assistantTranscript;
  }

  /** Resume the conversation from the newest transcript — once per boot, on
   *  the first assistant turn. The file keeps appending from there. */
  private loadAssistant(): void {
    if (this.assistantLoaded) return;
    this.assistantLoaded = true;
    const file = newestTranscriptFile(this.assistantDir());
    if (!file) return;
    const loaded = loadTranscriptFile(file);
    if (!loaded.messages.length) return;
    this.assistantHistory.push(...loaded.messages);
    this.assistantTranscript = new Transcript(loaded.header ?? {
      type: 'session', agent: 'assistant', provider: 'unknown', model: 'unknown',
      created_at: new Date().toISOString(), system_prompt: assistantInstructions(),
    }, file);
  }

  /** Ensure the assistant has a session row. Created on first turn; after
   *  compaction a new one replaces it (the old row keeps its frozen totals). */
  private async ensureAssistantSession(workspaceId: string | null, folderId?: string | null): Promise<string> {
    if (this.assistantSessionId) return this.assistantSessionId;
    if (!workspaceId) throw new Error('no active workspace — /workspaces to pick one');
    const row = await createAssistantSession(this.deps.db, workspaceId, folderId);
    this.assistantSessionId = row.id;
    return row.id;
  }

  /** The swap landed: the record rolls to a fresh file and a NEW session row —
   *  the old session keeps its frozen token totals as the historical record.
   *  The summary opens the new file, the carried-over messages behind it. */
  private onAssistantCompacted(): void {
    // End the old session, start a new one on the next turn.
    this.assistantSessionId = null;
    this.assistantTranscript = null;
    this.transcript().appendAll([...this.assistantHistory]);
    const chat = this.assistantChat;
    if (chat) void chat.client.sendMessage(chat.dm, '🧠 Chat compacted — older messages are summarized.').catch(() => {});
  }
  /** The approval gate — gated tools ask the user here (approvals.ts). */
  private approvals = new Approvals();
  /** The upgrade checker — periodic GitHub release check + Telegram notification. */
  upgradeChecker: UpgradeChecker;


  constructor(private deps: TelegramEngineDeps) {
    this.f = injectFetch(deps.app);
    this.upgradeChecker = new UpgradeChecker({
      version: process.env.APP_VERSION ?? 'dev',
      health: async () => {
        try {
          const r = await (await this.call('/health')).json();
          return r.ok ? r : null;
        } catch { return null; }
      },
      triggerUpdate: async (tag) => {
        try {
          // restart_anyway: the approval DM already warns that running turns
          // are stopped and loop cards blocked — a tap on Approve is the
          // informed yes the /update guard asks for.
          const r = await (await this.call('/update', { method: 'POST', body: { tag, restart_anyway: true } })).json();
          return r.ok ? { ok: true } : { ok: false, error: r.error?.message ?? 'unknown' };
        } catch (e) { return { ok: false, error: (e as Error).message }; }
      },
      setting: async (key) => {
        const values = await settingsValues(this.turnDeps()).catch(() => ({} as Record<string, unknown>));
        return values[key];
      },
      token: () => this.token(),
      authorizedUser: async () => {
        const values = await settingsValues(this.turnDeps()).catch(() => ({} as Record<string, unknown>));
        const dm = Number(values.telegram_authorized_user ?? '');
        return Number.isFinite(dm) && dm ? dm : null;
      },
      makeClient: (token, dm) => new TelegramClient(token,
        (id, text) => { store.recordSent(deps.db, dm, id, text, { kind: 'assistant' }).catch(() => {}); },
        (id) => { store.deleteSent(deps.db, dm, id).catch(() => {}); }),
    });
    // Every card write in the system, all workspaces; alerts.ts decides which
    // are the loop's moves. Fire-and-forget: an alert that fails is logged,
    // never retried, and never touches the card.
    deps.events?.subscribeAll((workspaceId, e) => {
      this.alert(workspaceId, e).catch((err) => log.warn({ err: errStr(err) }, 'auto build alert failed'));
    });
  }

  // ── auto build alerts ────────────────────────────────────────────────────

  /** One DM per loop move into in_progress / blocked / done, when
   *  `telegram_auto_build_notifications` resolves on for that workspace and
   *  the bot is enabled for an authorized user. The bubble is recorded with
   *  the card's coding session as its origin, so a reply to it enters that
   *  session in code mode like a reply to any coder bubble. */
  private async alert(workspaceId: string, e: BoardEvent): Promise<void> {
    if (e.event !== 'card' || !e.from || e.from === e.card.status) return;   // the cheap test first — no I/O
    // One read: prefix + the setting resolved at this workspace's layer.
    const ws = await (await this.call(`/workspaces/${workspaceId}`)).json()
      .catch((err: Error) => { log.warn({ workspace: workspaceId, err: err.message }, 'workspace read failed — no board alert'); return null; }) as { ok: boolean; data?: { cardPrefix: string;
        settings: Record<string, { value: unknown }> } } | null;
    if (!ws?.ok || !ws.data) return;
    const alert = autoBuildAlert(e, ws.data.cardPrefix);
    if (!alert) return;
    if (ws.data.settings.telegram_auto_build_notifications?.value !== true) return;
    if (ws.data.settings.telegram_enabled?.value !== true) return;
    const dm = Number(ws.data.settings.telegram_authorized_user?.value ?? '');
    if (!dm || !Number.isFinite(dm)) return;
    const token = await this.token();
    if (!token) return;
    const loop = await currentLoop(this.deps.db, workspaceId, alert.seq);
    const origin: store.SentOrigin = loop
      ? { kind: 'session', sessionId: loop.codingSessionId } : { kind: 'assistant' };
    const client = new TelegramClient(token,
      (id, text) => { store.recordSent(this.deps.db, dm, id, text, origin).catch(() => {}); },
      (id) => { store.deleteSent(this.deps.db, dm, id).catch(() => {}); });
    await client.sendMessage(dm, alert.text);
    log.info({ workspace: workspaceId, card: alert.seq, status: alert.status }, 'auto build alert sent');
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
      const me = await client.getMe().catch((e: Error) => { log.warn({ err: e.message }, 'getMe failed — the bot has no name this boot'); return null; });
      const secret = acc.webhookSecret ?? crypto.randomBytes(32).toString('hex');
      // A read on every boot after the first: only re-register when the URL or
      // the subscription drifted (dropPending:false keeps queued messages).
      const info = await client.getWebhookInfo().catch((e: Error) => { log.warn({ err: e.message }, 'getWebhookInfo failed — re-registering'); return null; });
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

    // A tap on an inline button: approval gate (apv:) or upgrade (upg:).
    const tap = update.callback_query;
    if (tap) {
      if (String(tap.from?.id) !== authorized) return 200;
      if (!(await store.markUpdate(db, update.update_id))) return 200;
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
    if (!(await store.markUpdate(db, update.update_id))) return 200;

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
        this.run(dm, entry.msgs, values).catch((e) => log.error({ err: errStr(e) }, 'telegram turn failed'));
      }, 800);
      this.albums.set(groupId, entry);
      return 200;
    }

    this.run(dm, [msg], values).catch((e) => log.error({ err: errStr(e) }, 'telegram turn failed'));
    return 200;
  }

  // ── the turn ─────────────────────────────────────────────────────────────

  private async run(dm: number, msgs: any[], values: Record<string, unknown>): Promise<void> {
    const { db, encryptionKey } = this.deps;
    const msg = msgs[0];
    const token = await this.token();
    // The client records every bubble it sends, tagged with the current mode's
    // origin, so a reply or a reaction can find its conversation.
    let origin: store.SentOrigin = { kind: 'assistant' };
    const client = new TelegramClient(token,
      (id, text) => { store.recordSent(db, dm, id, text, origin).catch(() => {}); },
      (id) => { store.deleteSent(db, dm, id).catch(() => {}); });

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

      const acc = await store.getAccount(db, encryptionKey);
      origin = acc.mode === 'code' && acc.activeSessionId
        ? { kind: 'session', sessionId: acc.activeSessionId }
        : { kind: 'assistant' };

      const input = await this.resolveInput(client, dm, msgs, values, acc);
      if (input === null) return;

      // A question standing: the exact word answers it and is nothing else;
      // any other message declines it and goes on to queue as the follow-up.
      if (this.approvals.handleText(dm, input)) return;

      // Busy: queue the message into the SAME key's running turn. Code-mode
      // turns key by sessionId, so switching sessions starts independently;
      // the assistant is one conversation, so it stays one key.
      const busyKey = acc.mode === 'code' && acc.activeSessionId
        ? acc.activeSessionId : 'assistant';
      const running = this.busy.get(busyKey);
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
      await client.sendMarkdown(dm, titled('⚠️ Something went wrong', (e as Error).message)).catch(() => {});
      throw e;
    }
  }

  /** An assistant-mode turn: the in-memory Assistant conversation, streamed to
   *  the bubble. session_switch moves the active-session POINTER only — the
   *  assistant keeps the conversation; /code is how the user hands it over. */
  private async assistantTurn(client: TelegramClient, dm: number, message: string,
    values: Record<string, unknown>): Promise<void> {
    const { db } = this.deps;
    this.assistantValues = values;
    this.assistantChat = { client, dm };
    this.loadAssistant();
    const typing = startTyping(client, dm);
    const abort = new AbortController();
    const busyKey = 'assistant';
    this.busy.set(busyKey, { queue: [], abort });
    const acc = await store.getAccount(db, this.deps.encryptionKey);
    // The assistant can deliver a file it names from the active session's work
    // dir (its file tools are read-only, but it can point at one the coder made).
    const voiceOnly = String(values.telegram_reply_mode ?? 'text') === 'voice';
    const sink = makeTelegramSink(client, dm,
      acc.activeSessionId ? this.deliverConfig(acc.activeSessionId) : undefined,
      { voiceOnly });
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
      // Ensure the assistant has a session row for token tracking.
      const sessionId = await this.ensureAssistantSession(
        acc.activeWorkspaceId, acc.activeSessionId);
      const result = await runAssistantTurn(deps, this.assistantHistory, message, sink, {
        settings: values,
        workspaceId: () => acc.activeWorkspaceId ?? null,
        activeSession: () => active,
        onSwitch,
        approve: (ask, signal) => this.approvals.request(client, dm, ask, signal),
        onWorkspaceCreated,
      }, abort.signal, this.transcript());
      replyText = result.text;
      // Record this turn's token usage on the session row.
      const model = (() => { try { return agentModelConfig(values, 'assistant'); } catch { return undefined; } })();
      await addSessionUsage(db, sessionId, result.usage,
        model ? { provider: model.provider, model: model.model } : undefined).catch(
        (e) => log.warn({ err: errStr(e) }, 'assistant session usage update failed'));
      // Long chat? Summarize it in the background — turns never wait on it.
      this.compactor.kick(this.assistantHistory);
      // Any messages queued while we ran go out as one follow-up turn.
      const queued = this.busy.get(busyKey)?.queue ?? [];
      this.busy.delete(busyKey);
      await this.maybeSpeak(client, dm, values, replyText, typing);
      typing.stop();
      if (queued.length) await this.assistantTurn(client, dm, queued.join('\n\n'), values);
    } catch (e) {
      this.busy.delete(busyKey);
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
    this.busy.set(sessionId, { queue: [], abort });
    // Files the agent names in its reply are delivered from this session's work
    // dir; the agent writes /workspace/... container paths, which map there.
    const voiceOnly = String(values.telegram_reply_mode ?? 'text') === 'voice';
    const sink = makeTelegramSink(client, dm, this.deliverConfig(sessionId), { voiceOnly });
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
      const s = await getSession(db, sessionId);
      const workspaceId = s?.workspaceId ?? '';
      const planMode = s?.planMode === true;
      // The agent's deliberate "DM the user" tool — sends through this chat,
      // reading the reply mode at the delivery end.
      const send = sendMessageTool((text) => this.sendDm(client, dm, values, text));
      // `signal` is what makes the turn stoppable at all: /stop aborts this
      // controller through the busy map, a remote interrupt through the feed
      // subscription above — runCodingTurn ends it cleanly (interrupted, not
      // failed) either way.
      const deps: TurnDeps = { ...this.turnDeps(), extraTools: send, signal: abort.signal };
      const r = await runCodingTurn(deps, opened, workspaceId, message, planMode, values);
      unsubscribe?.();
      await sink.done(r.text);
      const queued = this.busy.get(sessionId)?.queue ?? [];
      this.busy.delete(sessionId);
      await opened.close();
      await this.maybeSpeak(client, dm, values, r.text, typing);
      typing.stop();
      if (queued.length) await this.codeTurn(client, dm, sessionId, queued.join('\n\n'), values);
      return;
    } catch (e) {
      unsubscribe?.();
      await sink.dispose();
      this.busy.delete(sessionId);
      await opened.close().catch(() => {});
      typing.stop();
      await client.sendMessage(dm, `⚠️ ${(e as Error).message}`).catch(() => {});
    }
  }

  /** Speak the reply when the mode asks. Long replies are split into chunks
   *  so audio starts playing in under a second — two synthesis requests fly
   *  in parallel, sent in order, dots between pieces. In `voice` mode the
   *  sink withheld the text, so a failed synthesis falls back to sending it.
   *  `typing` is the turn's indicator loop — swapped to `record_voice` while
   *  synthesis runs so the user sees "recording audio…" instead of "typing…". */
  private async maybeSpeak(client: TelegramClient, dm: number,
    values: Record<string, unknown>, text?: string,
    typing?: { set(a: string): void }): Promise<void> {
    const mode = String(values.telegram_reply_mode ?? 'text');
    if (mode !== 'voice' && mode !== 'both') return;
    const say = (text ?? '').trim();
    if (!say) return;
    const apiKey = (await resolveCredential(this.deps.db, this.deps.encryptionKey, 'deepgram_api_key').catch(() => '')) ?? '';
    if (!apiKey) {
      if (mode === 'voice') await client.sendMarkdown(dm, say).catch(() => {});
      return;
    }
    typing?.set('record_voice');
    const voice = String(values.voice_spoken_voice ?? '');
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

  // ── input: voice, attachments, text ──────────────────────────────────────

  private async resolveInput(client: TelegramClient, dm: number, msgs: any[],
    values: Record<string, unknown>, acc: store.TelegramAccountRow): Promise<string | null> {
    const msg = msgs[0];
    // Telegram puts the caption on only one album item.
    const typed = msgs.map((m) => String(m.text ?? m.caption ?? '').trim()).find(Boolean) ?? '';

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
      if ('error' in heard) { await react(); await client.sendMessage(dm, NOT_HEARD[heard.error]); return null; }
      if (!heard.text) { await react(); await client.sendMessage(dm, "🎤 I couldn't make out any speech in that."); return null; }
      // Transcription succeeded — the 👍 replaces the ✍ as immediate feedback.
      await react(REACT_HEARD);
      if (values.telegram_transcript_echo === true) await client.sendMessage(dm, `🎤 "${heard.text}"`);
      return heard.text;
    }

    // A round video message (video_note) is treated like a voice note for now:
    // download, extract audio, transcribe. Full video processing later.
    const videoNote = msg.video_note;
    if (videoNote && !typed) {
      const react = (emoji?: string) => client.setMessageReaction(dm, msg.message_id, emoji).catch(() => {});
      if (videoNote.file_size && videoNote.file_size > MAX_INBOUND_BYTES) {
        await client.sendMessage(dm, "⚠️ That video note is over Telegram's 20 MB limit for bots.");
        return null;
      }
      const apiKey = (await resolveCredential(this.deps.db, this.deps.encryptionKey, 'deepgram_api_key').catch(() => '')) ?? '';
      if (!apiKey) { await client.sendMessage(dm, NOT_HEARD.no_key); return null; }
      const [, audio] = await Promise.all([react(REACT_TRANSCRIBING), client.downloadFile(videoNote.file_id)])
        .catch(async (e) => { await react(); throw e; });
      const heard = await transcribeVoice(apiKey, audio, String(values.voice_stt_model ?? ''));
      if ('error' in heard) { await react(); await client.sendMessage(dm, NOT_HEARD[heard.error]); return null; }
      if (!heard.text) { await react(); await client.sendMessage(dm, "🎤 I couldn't make out any speech in that."); return null; }
      await react(REACT_HEARD);
      if (values.telegram_transcript_echo === true) await client.sendMessage(dm, `🎤 "${heard.text}"`);
      return heard.text;
    }

    // Everything else file-bearing: save to the session's scratch, describe it.
    // Attachments only land in code mode (there is a session's scratch to use).
    // Collect from ALL messages — an album sends each photo as a separate update.
    const files = msgs.flatMap(collectFiles);
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
    const msg = mode === 'code'
      ? await this.codeModeLabel()
      : undefined;
    const changed = await store.setMode(this.deps.db, mode, (t) => client.sendMessage(dm, t), msg);
    await client.setMyCommands(menuFor(mode), dm).catch(() => {});
    return changed;
  }

  /** The short line sent when entering code mode — workspace prefix, card ID,
   *  session name. One function, used by enterMode and the /code echo. */
  async codeModeLabel(): Promise<string> {
    const acc = await store.getAccount(this.deps.db, this.deps.encryptionKey);
    if (!acc.activeSessionId) return '🤖 Coding agent';
    const s = await getSession(this.deps.db, acc.activeSessionId);
    if (!s) return '🤖 Coding agent';
    const loop = await loopOf(this.deps.db, acc.activeSessionId);
    const ws = await (await this.call(`/workspaces/${s.workspaceId}`)).json().catch(() => null);
    const prefix: string | undefined = ws?.ok ? ws.data.cardPrefix : undefined;
    const parts: string[] = ['🤖 Coding agent'];
    if (prefix) parts.push(prefix);
    if (prefix && loop?.card != null) parts.push(`${prefix}-${loop.card}`);
    else if (loop?.card != null) parts.push(`#${loop.card}`);
    parts.push(s.name ?? 'untitled');
    return parts.join(' · ');
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
    client.sendChatAction(dm, 'record_voice').catch(() => {});
    const audio = await speakVoice(apiKey, String(values.voice_spoken_voice ?? ''),
      stored.content.replace(/\n\n\(\d+\/\d+\)$/, '').slice(0, SPEAK_MAX_CHARS));
    if (audio) await client.sendVoiceBytes(chatId, audio, { replyToMessageId: messageId }).catch(() => {});
    else await client.sendMessage(chatId, "⚠️ I couldn't turn that into audio — check the Deepgram key.",
      { replyToMessageId: messageId }).catch(() => {});
  }

  // ── /stop and command support (used by commands.ts) ──────────────────────

  /** Stop the in-flight turn for the given busy key (a sessionId in code mode,
   *  'assistant' in assistant mode). Returns whether one was running. OUR
   *  turn only: stopping someone else's is the interrupt route's job, and
   *  commands.ts calls it for exactly that. */
  stop(key: string): boolean {
    const b = this.busy.get(key);
    if (!b) return false;
    b.queue.length = 0;
    b.abort.abort();
    return true;
  }

  get store() { return store; }
  get db() { return this.deps.db; }
  get key() { return this.deps.encryptionKey; }
  assistantReset() { this.assistantHistory = []; }

  /** The approval gate, for slash commands that need a confirm (today:
   *  /restart). Same gate gated tools use — one question per chat. */
  askApproval(client: TelegramClient, dm: number, ask: Ask): Promise<boolean> {
    return this.approvals.request(client, dm, ask);
  }

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
    return { json: () => r.json(), text: () => r.text() };
  }

  /** `/auto_push` and `/auto_pull` — core's one client of each git route, as
   *  the telegram client; every step reaches `onStep` in words, so the command
   *  can show them. Never throws: a refusal is a result too. */
  async autoPush(session: string, onStep?: (label: string) => void): Promise<AutoPushOutcome> {
    try { return await autoPushSession({ baseUrl: BASE, apiKey: this.deps.apiKey, sessionId: session, fetch: this.f, clientId: CLIENT_ID }, onStep); }
    catch (e) { return { result: 'error', reason: (e as Error).message }; }
  }
  async autoPull(session: string, onStep?: (label: string) => void): Promise<AutoPullOutcome> {
    try { return await autoPullSession({ baseUrl: BASE, apiKey: this.deps.apiKey, sessionId: session, fetch: this.f, clientId: CLIENT_ID }, onStep); }
    catch (e) { return { result: 'error', reason: (e as Error).message }; }
  }

  private turnDeps(): TurnDeps {
    return { f: this.f, apiKey: this.deps.apiKey, base: BASE,
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

  /** Deliver one deliberate message (send_message tool, or the assistant): the
   *  text as a bubble, spoken too when the reply mode asks. */
  private async sendDm(client: TelegramClient, dm: number, values: Record<string, unknown>, text: string):
  Promise<{ ok: boolean; error?: string }> {
    const say = String(text ?? '').trim();
    if (!say) return { ok: false, error: 'empty message' };
    const mode = String(values.telegram_reply_mode ?? 'text');
    try {
      if (mode !== 'voice') await client.sendMarkdown(dm, say);
      if (mode === 'voice' || mode === 'both') await this.maybeSpeak(client, dm, values, say);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
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
