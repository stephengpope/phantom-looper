// Every session you have opened in this window, and the one turn each of them
// may be running.
//
// This lives OUTSIDE React on purpose. A turn keeps streaming while you are
// looking at a different session, so its parts cannot land in component state
// belonging to whatever is on screen — `onParts` closes over the entry it was
// started for, never over "the active one". Same shape as Shockwave's
// chatStore (renderer/ChatSidebar.tsx): the store owns the conversations and
// the subscription, the component is a view over the active entry.
//
// Order is by LAST MESSAGE SENT, not by visiting. Tabbing through sessions
// must not reorder the thing you are tabbing through, or the ring moves under
// your fingers; only saying something to a session makes it recent.
import type { ModelMessage, Tool } from 'ai';
import type { Agent } from './agent.js';
import { runTurn } from './agent.js';
import type { AgentSummary } from './agentFromConfig.js';
import { Transcript } from './session.js';
import { applyPart, applyTokens, finalize, nextId, takeCompleted, NO_TOKENS, type Part, type StreamPart, type TurnTokens } from './state.js';

export interface LoadedSession {
  /** The frozen system prompt this session was created with, if stored. */
  instructions?: string;
  id: string;
  branch: string;
  workspaceId: string;
  /** The kanban card this session is building, already named the way the
   *  board names it (`PHA-7`). Absent when the session belongs to no card —
   *  anything you started yourself. */
  card?: string;
  /** Per session: the adapter derives them from the session's own /tools. */
  tools: Record<string, Tool>;
  agent: Agent;
  summary: AgentSummary;
  transcript: Transcript;
  /** What goes to the model. Mutated in place; the store notifies. */
  history: ModelMessage[];
  /** Finished parts — what <Static> prints. */
  done: Part[];
  /** A supervised session's OTHER conversation (the supervisor's rounds),
   *  already rendered. Empty on ordinary sessions. */
  /** A supervisor session's record is read-only — viewing, never chatting. */
  readonly: boolean;
  /** /plan: the coding agent's mutating kits are built with the readonly
   *  preset while this is on. The server row (sessions.plan_mode) is the
   *  record; this mirrors it, seeded at open, flipped by setPlanMode. */
  planMode: boolean;
  /** The server transcript's stamp our memory matches (null = never synced).
   *  Compared against the lock response's stamp at each turn start; a
   *  mismatch means another machine advanced the session — pull, reseat,
   *  THEN run. Memory does all the work while the stamps agree. */
  syncStamp: string | null;
  /** The block being written right now. */
  live: Part[];
  /** Accumulating turn, pre-split. Per entry or a background turn's output
   *  lands in the visible session. */
  turn: Part[];
  busy: boolean;
  /** A turn the SERVER is running on this session, streamed here over the
   *  session feed. Separate from `busy` on purpose: busy means this window
   *  owns the turn (esc stops it, the prompt is held); this means someone
   *  else is working and we are watching. Drives the working line only. */
  remoteBusy: boolean;
  /** Who holds this session right now, when it is not us — off the feed's
   *  `lock` records (the first thing a feed sends, then every change). The
   *  toolbar spins on it; `expiresAt` lets the window clear it on its own
   *  clock if the holder died without releasing. */
  held: { who?: string; label: string; expiresAt: number } | null;
  startedAt: number;
  /** Output tokens so far this turn (status line). Reset when a turn starts. */
  tokens: TurnTokens;
  abort: AbortController | null;
  /** Typed while a turn was running. Sent together, in order, as ONE turn
   *  when the running one ends — the way Claude Code holds lines under the
   *  active turn. Per session: what you queued for one is not said to
   *  another. */
  queue: string[];
  /** Finished (or failed) while you were looking somewhere else. */
  unseen: boolean;
  /** Drives cycle order. 0 until the first message is sent. */
  lastMessageAt: number;
  /** Insertion counter — the tie-break while nothing has been said yet. */
  addedAt: number;
}

export interface NewSession {
  id: string; branch: string; workspaceId: string;
  /** The card this session builds, named `PHA-7` (see LoadedSession.card). */
  card?: string;
  tools: Record<string, Tool>;
  agent: Agent; summary: AgentSummary;
  transcript: Transcript;
  /** The session's FROZEN system prompt (see TranscriptHeader.system_prompt).
   *  Kept so a model change rebuilds the agent with the same instructions. */
  instructions?: string;
  /** Replayed from a transcript when resuming; empty otherwise. */
  history?: ModelMessage[];
  /** The banner and the replayed conversation, already rendered to parts. */
  done?: Part[];
  /** The supervisor conversation, rendered — supervised sessions only. */
  readonly?: boolean;
  /** The server row's plan_mode — the tools passed above must already match. */
  planMode?: boolean;
  syncStamp?: string | null;
  /** Open showing the supervisor side (the run's story) first. */
}

/** Injectable so tests drive turns without a model. */
export type RunTurn = typeof runTurn;

export class SessionStore {
  private entries: LoadedSession[] = [];
  private listeners = new Set<() => void>();
  private seq = 0;
  activeId = '';

  /** `onTurnEnd` fires after every turn settles (answered, failed or
   *  interrupted) — the App's transcript upload hangs off it. Best effort by
   *  contract: it must never block the queue or throw into `send`. */
  /** Turn-start hook: acquire the session lock (App wires the API call).
   *  Throwing refuses the turn — the text is dropped with a note that quotes
   *  it. It does NOT queue: the queue is only for this window's own running
   *  turn, never for a lock held elsewhere. */
  onTurnStart?: (id: string) => Promise<void>;
  /** The relay: this window's own turn, published to the server as it runs
   *  (App wires `POST /sessions/:id/events`), so a watcher anywhere sees it
   *  exactly as they see a turn the server runs — one feed, whoever drives.
   *  The records are the same ones the server publishes for its turns:
   *  turn-start, each flush of parts, turn-end (and error). Sent in order,
   *  one request behind the other; the FIRST failure ends the relay for
   *  that turn — a watcher then never gets turn-end, and repaints from the
   *  record when it lands, which is the honest outcome. The turn itself
   *  never waits on it and never fails for it. */
  relay?: (id: string, events: Record<string, unknown>[]) => Promise<void>;
  constructor(private run: RunTurn = runTurn,
    private onTurnEnd?: (e: LoadedSession) => void) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void { for (const l of [...this.listeners]) l(); }

  get(id: string): LoadedSession | undefined {
    return this.entries.find((e) => e.id === id);
  }

  has(id: string): boolean { return this.entries.some((e) => e.id === id); }

  active(): LoadedSession | undefined { return this.get(this.activeId); }

  /** Every loaded session, most recently spoken to first. */
  list(): LoadedSession[] {
    return [...this.entries].sort(
      (a, b) => (b.lastMessageAt - a.lastMessageAt) || (b.addedAt - a.addedAt));
  }

  /** Add and make active. Adding one you already have just activates it —
   *  /resume on a session that is already open must not open it twice. */
  add(s: NewSession): LoadedSession {
    const existing = this.get(s.id);
    if (existing) { this.activate(existing.id); return existing; }
    const entry: LoadedSession = {
      id: s.id, branch: s.branch, workspaceId: s.workspaceId, card: s.card,
      tools: s.tools, agent: s.agent, summary: s.summary, transcript: s.transcript,
      instructions: s.instructions,
      history: [...(s.history ?? [])],
      done: [...(s.done ?? [])],
      readonly: s.readonly ?? false,
      planMode: s.planMode ?? false,
      syncStamp: s.syncStamp ?? null,
      live: [], turn: [],
      busy: false, remoteBusy: false, held: null, startedAt: 0, tokens: NO_TOKENS, abort: null, queue: [],
      unseen: false, lastMessageAt: 0, addedAt: ++this.seq,
    };
    this.entries.push(entry);
    this.activeId = entry.id;
    this.notify();
    return entry;
  }

  /** Switching to a session is how you read it, so its mark clears here. */
  activate(id: string): boolean {
    const e = this.get(id);
    if (!e || this.activeId === id) return false;
    this.activeId = id;
    e.unseen = false;
    this.notify();
    return true;
  }

  /** Drop a session from THIS window: it leaves the tab ring, the open-session
   *  list and its dot in /resume. The server keeps everything — the row, the
   *  transcript, the files — so /resume opens it again unchanged; this is
   *  closing a tab, not deleting anything (that is [t]rash).
   *
   *  Refused while a turn is running here: the stream's `onParts` closes over
   *  this entry, so dropping it mid-turn would fold output into a session
   *  nothing can show. Stop the turn first (esc), then drop. */
  close(id: string): boolean {
    const e = this.get(id);
    if (!e || e.busy) return false;
    this.entries = this.entries.filter((x) => x.id !== id);
    // Dropping the one on screen leaves NOTHING on screen, deliberately: what
    // comes next is the App's call through switchTo (the one path that puts a
    // session in the pane — scroll, history, the staleness check). The store
    // does not get a second, quieter way to change what you are looking at.
    if (this.activeId === id) this.activeId = '';
    this.notify();
    return true;
  }

  /** The next session round the ring, or undefined when there is only one. */
  next(dir: 1 | -1 = 1): LoadedSession | undefined {
    const order = this.list();
    if (order.length < 2) return undefined;
    const at = order.findIndex((e) => e.id === this.activeId);
    return order[((at < 0 ? 0 : at) + dir + order.length) % order.length];
  }

  /** A one-line note in a session's transcript view (never in its history). */
  setStamp(id: string, stamp: string | null): void {
    const e = this.get(id);
    if (e) e.syncStamp = stamp;
  }

  /** Take the server's copy of a session that moved elsewhere. History and
   *  stamp ALWAYS move: the record is the server's, it is what the next turn
   *  is built from, and the stamp is what stops the watch pulling it again.
   *
   *  `parts` is the SCREEN, and it is optional: pass the rendered transcript
   *  to repaint, or null to keep what is already drawn. Null is for a turn
   *  this window watched from start to finish over the session feed — what we
   *  drew came off the same stream the server recorded, and it is RICHER
   *  (thinking, live tool timings) than a transcript replay, so repainting it
   *  would only make the screen jump and lose detail. Anything less than a
   *  clean watch — joined mid-turn, a reconnect, a clipped tool result,
   *  another window's work — passes parts and repaints. */
  reseat(id: string, history: ModelMessage[], parts: Part[] | null, stamp: string | null): void {
    const e = this.get(id);
    if (!e) return;
    e.history = [...history];
    if (parts) {
      // The one place the live region is discarded: a repaint replaces the
      // whole conversation, so a half-streamed tail must not survive it.
      e.done = [...parts];
      e.live = [];
      e.turn = [];
    }
    e.syncStamp = stamp;
    this.notify();
  }

  // ── a turn someone ELSE is running, streamed here as it happens ───────────
  // The server publishes every part of a turn it runs (looper round, the turn
  // route); SessionFeed folds them in through these three. They are the same
  // machinery a local turn uses — applyPart, the same block splitting — so a
  // watched turn and a driven turn are drawn by one renderer.
  //
  // `busy` deliberately stays FALSE: this window is not running the turn, esc
  // cannot stop it, and nothing here may claim otherwise. What marks the
  // session as working is the toolbar's holder spinner, which the watch owns.

  /** A remote turn began: its user message joins the conversation (so the
   *  reply is not answering a question nobody can see) and any stale live
   *  block goes. */
  remoteStart(id: string, text: string): void {
    const e = this.get(id);
    if (!e || e.busy) return;
    e.turn = [];
    e.live = [];
    e.remoteBusy = true;
    e.startedAt = Date.now();
    e.tokens = NO_TOKENS;
    if (text.trim()) e.done = [...e.done, { kind: 'user', id: nextId('user'), text }];
    this.notify();
  }

  /** A flush of parts off the feed. Ignored while this window runs its own
   *  turn — that output is the one thing the live region belongs to. */
  remoteParts(id: string, parts: StreamPart[]): void {
    const e = this.get(id);
    if (!e || e.busy) return;
    // Parts arriving IS a turn running — a window that joined after the
    // turn-start went by (no replay) learns it from the first part.
    if (!e.remoteBusy) { e.remoteBusy = true; e.startedAt = Date.now(); e.tokens = NO_TOKENS; }
    this.fold(e, parts);
    // fold repaints only the active session; a remote turn is only followed
    // while it IS the active one, so nothing extra is needed here.
  }

  /** The remote turn stopped. The tail still in the live region is closed and
   *  committed exactly the way a local turn's is — otherwise the last block
   *  would sit below the pane for ever. The record arrives separately (the
   *  feed's `transcript` event → reseat). */
  remoteEnd(id: string): void {
    const e = this.get(id);
    if (!e || e.busy) return;
    // Nothing was in flight (the feed just closed on a quiet session): leave
    // the session exactly as it is — in particular do not mark it unseen.
    if (!e.remoteBusy && !e.turn.length) return;
    e.remoteBusy = false;
    const rest = finalize(e.turn);
    e.turn = [];
    e.live = [];
    if (rest.length) e.done = [...e.done, ...rest];
    if (e.id !== this.activeId) e.unseen = true;
    this.notify();
  }

  /** The feed said who holds the session (or that nobody does). */
  setHeld(id: string, held: LoadedSession['held']): void {
    const e = this.get(id);
    if (!e) return;
    e.held = held;
    this.notify();
  }

  note(id: string, text: string): void {
    const e = this.get(id);
    if (!e) return;
    e.done = [...e.done, { kind: 'note', id: nextId('note'), text }];
    this.notify();
  }

  /** Interrupt the running turn. What was queued behind it stays queued —
   *  esc means "stop this", not "forget what I said next"; the queue is
   *  dropped explicitly with dequeue/clearQueue. */
  abortTurn(id: string): void { this.get(id)?.abort?.abort(); }

  /** Say it now if the session is free, otherwise hold it until it is. */
  say(id: string, text: string): void {
    const e = this.get(id);
    if (!e) return;
    if (!e.busy) { void this.send(id, text); return; }
    e.queue = [...e.queue, text];
    this.notify();
  }

  /** Drop everything queued, keep the turn running — the first esc. */
  clearQueue(id: string): void {
    const e = this.get(id);
    if (!e || !e.queue.length) return;
    e.queue = [];
    this.notify();
  }

  /** Take the last queued message back (↑ on the prompt while a turn runs —
   *  the way to edit something you said too soon). */
  unqueue(id: string): string | undefined {
    const e = this.get(id);
    if (!e || !e.queue.length) return undefined;
    const last = e.queue[e.queue.length - 1];
    e.queue = e.queue.slice(0, -1);
    this.notify();
    return last;
  }

  /** Every turn, everywhere — what quitting does. Without it a turn running in
   *  a session you were not looking at holds an open request, and node will not
   *  exit until it settles: the window closes and the shell hangs. */
  abortAll(): void { for (const e of this.entries) e.abort?.abort(); }

  /** /plan flipped: the mode and the toolset move together — the caller built
   *  the new kit (readonly or full) and the agent over it. A turn already
   *  streaming keeps the agent it started with (runTurn holds its own
   *  reference), so the switch lands on the next turn — /model's rule. */
  setPlanMode(id: string, on: boolean, tools: Record<string, Tool>, agent: Agent, summary: AgentSummary): void {
    const e = this.get(id);
    if (!e) return;
    e.planMode = on;
    e.tools = tools;
    e.agent = agent;
    e.summary = summary;
    this.notify();
  }

  /** /model changed: every loaded session gets the new model, not just the one
   *  on screen. A turn already streaming keeps the agent it started with —
   *  runTurn holds its own reference — so the switch lands on the next turn. */
  rebuildAgents(make: (tools: Record<string, Tool>, instructions?: string, id?: string) => { agent: Agent; summary: AgentSummary }): void {
    for (const e of this.entries) {
      const { agent, summary } = make(e.tools, e.instructions, e.id);
      e.agent = agent; e.summary = summary;
    }
    this.notify();
  }

  /** Run a turn on `id`, whether or not it is the session on screen. Several
   *  texts are several user messages in ONE turn — that is how a queue goes
   *  out: everything you said while the last turn ran, together, so the model
   *  answers the lot rather than each line in ignorance of the next. */
  async send(id: string, text: string | string[]): Promise<void> {
    const e = this.get(id);
    if (!e || e.busy) return;
    const texts = (Array.isArray(text) ? text : [text]).filter((t) => t.trim());
    if (!texts.length) return;

    // The lock lives for THIS TURN, not for having the session open: taken
    // here, released after the turn-end sync lands. The queue exists only
    // behind this window's own turn — a lock held elsewhere (another window,
    // a looper round) REFUSES the send: nothing waits around to fire into a
    // conversation someone else is shaping. The note keeps the words.
    if (this.onTurnStart) {
      try { await this.onTurnStart(id); }
      catch (err) {
        const why = (err as { code?: string }).code === 'session_locked'
            || (err as Error).message.includes('session_locked')
          ? 'session in use elsewhere' : (err as Error).message;
        this.note(id, `not sent — ${why}: ${texts.map((t) => `"${t}"`).join(' · ')}`);
        return;
      }
    }

    e.lastMessageAt = Date.now();
    for (const t of texts) {
      e.done = [...e.done, { kind: 'user', id: nextId('user'), text: t }];
      const message: ModelMessage = { role: 'user', content: t };
      e.history.push(message);
      e.transcript.append(message);
    }
    e.busy = true;
    e.startedAt = Date.now();
    e.tokens = NO_TOKENS;
    const ac = new AbortController();
    e.abort = ac;
    this.notify();

    // The relay chain: every batch waits for the one before it, so records
    // land in the order they were drawn. One failure and the rest of the
    // turn goes unrelayed (see `relay`).
    let chain = Promise.resolve();
    let relaying = !!this.relay;
    const relay = (events: Record<string, unknown>[]) => {
      if (!relaying) return;
      // Checked again when its turn in the chain comes: a batch queued before
      // an earlier one failed must not go out after it.
      chain = chain.then(() => { if (relaying) return this.relay!(id, events); })
        .catch(() => { relaying = false; });
    };
    relay([{ event: 'turn-start', agent: 'coding', message: texts.join('\n\n') }]);

    // ONE failure, ONE line. The SDK reports a failed call through two doors:
    // an `error` event in the stream (rendered in place by applyPart) AND the
    // turn's promise rejecting with the same error. Both reporters are needed
    // — the catch is the only coverage for failures the stream never sees (a
    // crash in our own code, a failure before the stream starts) — but when
    // the stream already spoke, the catch stays quiet.
    let streamErrored = false;
    try {
      await this.run(
        e.agent,
        e.history,
        (parts) => {
          if (parts.some((p) => p.type === 'error')) streamErrored = true;
          this.fold(e, parts);
          relay(parts.map((part) => ({ event: 'part', part })));
        },
        ac.signal,
        (stepMessages) => { e.history.push(...stepMessages); },
        undefined,
        // The transcript records the step — messages and usage line — through
        // createAgent's `record` seam, the same way every agent does.
        e.transcript,
      );
    } catch (err) {
      if (!ac.signal.aborted && !streamErrored) {
        e.turn = [...e.turn, { kind: 'error', id: nextId('err'), message: (err as Error).message }];
        // A failure the stream never reported: watchers must hear it too (a
        // stream-reported one already rode the feed as a part).
        relay([{ event: 'error', message: (err as Error).message }]);
      }
    } finally {
      // turn-end goes out before the transcript upload (onTurnEnd below), so
      // a watcher sees the turn close and THEN the record land — the order
      // that lets it keep the screen it drew.
      relay([{ event: 'turn-end' }]);
      await chain;
      const rest = finalize(e.turn);
      e.turn = [];
      // The turn's residue: the status line's elapsed total, kept in the
      // transcript once the spinner goes. Interrupts and errors count too —
      // the time was spent either way.
      const endedAt = Date.now();
      rest.push({ kind: 'worked', id: nextId('worked'), ms: endedAt - e.startedAt, at: endedAt });
      e.done = [...e.done, ...rest];
      e.live = [];
      e.busy = false;
      e.abort = null;
      // An error counts as something to come back to, same as an answer — a
      // session that fell over must not sit in the list looking idle.
      if (e.id !== this.activeId) e.unseen = true;
      this.notify();
      // The turn is on disk already (appended per step); the hook ships the
      // whole file to the server in the background.
      try { this.onTurnEnd?.(e); } catch { /* sync is best effort */ }
      // Whatever was typed while this ran goes next — ALL of it, as one turn
      // — but not after an interrupt: esc stops the session, and firing the
      // queue straight into it would be the opposite of stopping.
      if (e.queue.length && !ac.signal.aborted) {
        const batch = e.queue;
        e.queue = [];
        void this.send(e.id, batch);
      }
    }
  }

  /** Fold a flush of stream parts into the entry that produced them. */
  private fold(e: LoadedSession, parts: StreamPart[]): void {
    let t = e.turn;
    let tokens = e.tokens;
    for (const p of parts) { t = applyPart(t, p); tokens = applyTokens(tokens, p); }
    e.tokens = tokens;
    const split = takeCompleted(t);
    e.turn = split.live;
    if (split.done.length) e.done = [...e.done, ...split.done];
    e.live = split.live;
    // Only the session on screen needs a repaint; a background turn changes
    // nothing anyone is looking at until it finishes (which always notifies).
    if (e.id === this.activeId) this.notify();
  }
}
