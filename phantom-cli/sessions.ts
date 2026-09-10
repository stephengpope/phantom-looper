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
import type { ModelPin } from '../core/llm/agentConfig.js';
import { Transcript } from './session.js';
import { applyPart, applyTokens, finalize, nextId, takeCompleted, tokenCount, NO_TOKENS, type Part, type StreamPart, type TurnTokens } from './state.js';

export interface LoadedSession {
  /** The frozen system prompt this session was created with, if stored. */
  instructions?: string;
  id: string;
  branch: string;
  workspaceId: string;
  /** The server row's name — the auto-title or a /rename. Seeded at open and
   *  refreshed by /rename and by each landing's staleness GET; it can still
   *  lag the server (naming rides the save, fire-and-forget), so anything
   *  that must be exact re-reads the row. Null until the first title. */
  name: string | null;
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
  /** /star: pinned to the top of /resume. The server row (sessions.starred)
   *  is the record; this mirrors it so the picker's open-here extras carry
   *  the pin too — seeded at open, flipped by setStarred. */
  starred: boolean;
  /** The model this session is pinned to (core agentConfig): its row's
   *  provider/model/endpoint, or its transcript header's for a session older
   *  than those columns. Null only while nothing has been said — the one case
   *  the global settings apply. Every rebuild resolves through it, so no path
   *  can put a running conversation on a different model. */
  pin: ModelPin | null;
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
  /** Output tokens over the session's LIFE (the toolbar's `12.4k ↓`): the
   *  sum of the record's usage lines at the last seat (open or reseat — the
   *  local file IS the record's working copy), plus each finished turn's
   *  count folded in at turn end. A running turn's `tokens` ride on top live.
   *  An esc-cut step's estimate stands until the next seat recomputes. */
  totalTokens: number;
  abort: AbortController | null;
  /** Typed while a turn is running. The turn drains it whole into the very
   *  next model call (the nudge seam — a typed word steers the agent
   *  mid-turn); whatever is still here when the turn ends starts its own
   *  turn, one message at a time. ONE array per session, mutated in place —
   *  the running turn holds its reference. Per session: what you queued for
   *  one is not said to another. */
  queue: string[];
  /** Finished (or failed) while you were looking somewhere else. */
  unseen: boolean;
  /** Drives cycle order. 0 until the first message is sent. */
  lastMessageAt: number;
  /** Insertion counter — the tie-break while nothing has been said yet. */
  addedAt: number;
  /** Where this session's code stands: not_pushed, not_merged, merged. Null
   *  before the first poll lands or when the server could not read it. */
  work: 'not_pushed' | 'not_merged' | 'merged' | null;
  /** The unsent text in the prompt when the user switched away from this
   *  session. Restored into the input box when returning. */
  draft: string;
}

/** Is someone else working in this session right now? The hold's expiry is a
 *  clock, and a turn that outruns it keeps streaming — so observed activity
 *  (parts arriving, no turn-end yet) counts too. THE one answer: the toolbar
 *  spinner, the esc-stop and the send guard all read this, or they drift —
 *  the last time they answered separately, a lapsed clock let a second turn
 *  start on a live conversation. */
export const activeHold = (e: LoadedSession | undefined | null): LoadedSession['held'] =>
  e?.held && (e.held.expiresAt > Date.now() || e.remoteBusy) ? e.held : null;

export interface NewSession {
  id: string; branch: string; workspaceId: string;
  /** The server row's name at open (see LoadedSession.name). */
  name?: string | null;
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
  /** The server row's starred (LoadedSession.starred). */
  starred?: boolean;
  syncStamp?: string | null;
  /** The model this session is pinned to (LoadedSession.pin). Absent only for
   *  a session with nothing said yet. */
  pin?: ModelPin | null;
  /** Output tokens summed from the seated transcript (LoadedSession.totalTokens). */
  totalTokens?: number;
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
      id: s.id, branch: s.branch, workspaceId: s.workspaceId, name: s.name ?? null, card: s.card,
      tools: s.tools, agent: s.agent, summary: s.summary, transcript: s.transcript,
      instructions: s.instructions,
      history: [...(s.history ?? [])],
      done: [...(s.done ?? [])],
      readonly: s.readonly ?? false,
      planMode: s.planMode ?? false,
      starred: s.starred ?? false,
      syncStamp: s.syncStamp ?? null,
      pin: s.pin ?? null,
      live: [], turn: [],
      busy: false, remoteBusy: false, held: null, startedAt: 0, tokens: NO_TOKENS,
      totalTokens: s.totalTokens ?? 0, abort: null, queue: [],
      // A session with history AND a pin has its model settled. History with
      // NO pin is a duplicate's copy: its messages came from the source, so
      // they do not settle it — it follows /model and presets until its first
      // NEW message, exactly like a fresh session (rebuildAgents reads this).
      unseen: false, lastMessageAt: s.history?.length && s.pin ? Date.now() : 0, addedAt: ++this.seq, work: null, draft: '',
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

  /** The window's copy of the server name moves with /rename and with the
   *  staleness GET each landing makes. */
  setName(id: string, name: string | null): void {
    const e = this.get(id);
    if (!e || e.name === name) return;
    e.name = name;
    this.notify();
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

  setWork(id: string, work: LoadedSession['work']): void {
    const e = this.get(id);
    if (e && e.work !== work) { e.work = work; this.notify(); }
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
  reseat(id: string, history: ModelMessage[], parts: Part[] | null, stamp: string | null,
    totalTokens?: number): void {
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
    // The record just landed whole, so its exact sum replaces whatever the
    // live folds had accumulated — no estimate survives a reseat.
    if (totalTokens !== undefined) e.totalTokens = totalTokens;
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
    // The watched turn's tokens join the session total; the record landing
    // behind it (the feed's `transcript` event → reseat) replaces the base
    // with the exact sum, so an estimate never stands for long.
    e.totalTokens += tokenCount(e.tokens);
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

  /** Interrupt the running turn. The queue's front message starts
   *  immediately (esc = "skip to next"). With an empty queue, esc just
   *  stops. */
  abortTurn(id: string): void { this.get(id)?.abort?.abort(); }

  /** Say it now if the session is free, otherwise queue it behind the
   *  running turn. The queue is ONE array per session, mutated in place,
   *  never replaced: the running turn holds its reference and drains it
   *  into the next model call (the nudge seam in createAgent), so a new
   *  array would be a queue the turn cannot see. */
  say(id: string, text: string): void {
    const e = this.get(id);
    if (!e) return;
    if (!e.busy) { void this.send(id, text); return; }
    e.queue.push(text);
    this.notify();
  }

  /** Drop everything queued — the backing method for `/pop all`. */
  clearQueue(id: string): void {
    const e = this.get(id);
    if (!e || !e.queue.length) return;
    e.queue.length = 0;
    this.notify();
  }

  /** Take the last queued message back — the backing method for `/pop`. */
  unqueue(id: string): string | undefined {
    const e = this.get(id);
    if (!e || !e.queue.length) return undefined;
    const last = e.queue.pop();
    this.notify();
    return last;
  }

  /** Every turn, everywhere — what quitting does. Without it a turn running in
   *  a session you were not looking at holds an open request, and node will not
   *  exit until it settles: the window closes and the shell hangs. */
  abortAll(): void { for (const e of this.entries) e.abort?.abort(); }

  /** /star flipped: the mirror follows the server row (the PATCH landed
   *  before this is called), so an open-here extra in /resume pins too. */
  setStarred(id: string, on: boolean): void {
    const e = this.get(id);
    if (!e || e.starred === on) return;
    e.starred = on;
    this.notify();
  }

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

  /** /model changed: only sessions with nothing said yet get the new model.
   *  A session that has spoken keeps its model for life — the pin.
   *  A turn already streaming keeps the agent it started with — runTurn holds
   *  its own reference — so the switch lands on the next turn. */
  rebuildAgents(make: (tools: Record<string, Tool>, instructions?: string, id?: string) => { agent: Agent; summary: AgentSummary }): void {
    for (const e of this.entries) {
      if (e.pin || e.lastMessageAt > 0) continue;   // pinned: this session's model is settled
      const { agent, summary } = make(e.tools, e.instructions, e.id);
      e.agent = agent; e.summary = summary;
    }
    this.notify();
  }

  /** Run a turn on `id`, whether or not it is the session on screen. Each
   *  queued message gets its own turn — the queue drains one at a time,
   *  whether the turn ended normally or was interrupted. */
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
        // The nudge seam: the turn drains this queue into the very next
        // model call mid-turn (what stays queued at turn end starts its own
        // turn below, as ever). Whatever was poured lands in the transcript
        // through the record seam; here it joins history and the screen.
        { queued: e.queue, onNudge: (texts) => {
          for (const t of texts) {
            e.done = [...e.done, { kind: 'user', id: nextId('user'), text: t }];
            e.history.push({ role: 'user', content: t });
          }
          this.notify();
        } },
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
      // The turn's output joins the session's lifetime total (the toolbar's
      // number). Settled is exact — every step ended with a finish-step's
      // real usage; only an esc-cut step leaves an estimate, and the next
      // seat recomputes from the record.
      e.totalTokens += tokenCount(e.tokens);
      // An error counts as something to come back to, same as an answer — a
      // session that fell over must not sit in the list looking idle.
      if (e.id !== this.activeId) e.unseen = true;
      this.notify();
      // The turn is on disk already (appended per step); the hook ships the
      // whole file to the server in the background.
      try { this.onTurnEnd?.(e); }
      catch (err) { this.note(e.id, `transcript sync failed (kept locally): ${(err as Error).message}`); }
      // Whatever was typed while this ran goes next — one message per turn,
      // whether the turn ended on its own or was interrupted. Esc becomes
      // "skip to next": abort fires, the front message starts immediately.
      if (e.queue.length) {
        const next = e.queue.shift()!;
        void this.send(e.id, next);
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
