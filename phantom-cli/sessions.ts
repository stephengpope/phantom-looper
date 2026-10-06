// Every session you have opened in this window, and the one turn each of them
// may be running.
//
// Each open session IS a `CodingAgent` (the client SDK): the agent holds the
// conversation, runs the turn, writes the record, and tells this store what
// happened through its events. The store keeps what the SCREEN needs — the
// rendered parts, the live block, the spinner's clock and token count, the
// banner's model line — and nothing the agent already holds.
//
// This lives OUTSIDE React on purpose. A turn keeps streaming while you are
// looking at a different session, so its parts cannot land in component state
// belonging to whatever is on screen — every listener closes over the entry
// it was wired for, never over "the active one".
//
// Order is by LAST MESSAGE SENT, not by visiting. Tabbing through sessions
// must not reorder the thing you are tabbing through, or the ring moves under
// your fingers; only saying something to a session makes it recent.
import type { ModelMessage } from 'ai';
import type { PhantomError, StreamPart as AgentStreamPart, TokenTotals } from '@phantom-agent-sdk/client';
import type { CodingAgent } from '../phantom-looper/agents/coding.js';
import type { Dialog } from './window.js';
import { applyPart, applyTokens, finalize, nextId, takeCompleted, tokenCount, NO_TOKENS, messagesToParts,
  type Part, type StreamPart, type TurnTokens } from './state.js';

/** The banner's model line: the row's provider/model and the reasoning
 *  setting at open; what turn-start answers after. */
export interface ModelLine { provider: string; model: string; reasoning: string }

/** How long stream parts may sit before the pane sees them. A setState per
 *  token is the classic Ink flicker; a few parts per paint keeps it smooth. */
export const FLUSH_MS = 150;

export interface LoadedSession {
  id: string;
  branch: string;
  projectId: string;
  /** The server row's name — the auto-title or a /rename. Seeded at open and
   *  refreshed by /rename and by each landing's staleness GET. Null until the
   *  first title. */
  name: string | null;
  /** The kanban card this session is building, already named the way the
   *  board names it (`PHA-7`). Absent when the session belongs to no card. */
  card?: string;
  /** The agent: the conversation, the turn, the record. */
  agent: CodingAgent;
  /** This window owns a turn on the session right now (the agent's word). */
  readonly busy: boolean;
  /** The conversation as the agent holds it (the agent's, never copied). */
  readonly history: readonly ModelMessage[];
  /** A turn this window started is still to be settled on screen: set when
   *  enter sends, cleared when the turn's residue is drawn. Guards the one
   *  settle per turn, whichever way it ended. */
  turnOpen: boolean;
  /** The banner's model line. */
  summary: ModelLine;
  /** Finished parts — what <Static> prints. */
  done: Part[];
  /** /plan: the server row (sessions.plan_mode) is the record; the agent
   *  reads it at every turn start and off the feed mid-turn. This mirrors it
   *  for the toolbar only — seeded at open, flipped by setPlanMode. */
  planMode: boolean;
  /** /pin: pinned to the top of /resume. The server row is the record; this
   *  mirrors it — seeded at open, flipped by setPinned. */
  pinned: boolean;
  /** The server transcript's stamp the SCREEN matches (null = never seated).
   *  The feed compares it when another writer's record lands, so the pane
   *  repaints once; the agent keeps its own copy current on its own. */
  syncStamp: string | null;
  /** The block being written right now. */
  live: Part[];
  /** Accumulating turn, pre-split. */
  turn: Part[];
  /** A turn the SERVER is running on this session, streamed here over the
   *  session feed. Separate from `busy` on purpose: busy means this window
   *  owns the turn (esc stops it, the prompt is held); this means someone
   *  else is working and we are watching. Drives the working line only. */
  remoteBusy: boolean;
  /** Who holds this session right now, when it is not us — off the feed's
   *  `lock` records. The toolbar spins on it; `expiresAt` lets the window
   *  clear it on its own clock if the holder died without releasing. */
  held: { who?: string; label: string; expiresAt: number } | null;
  startedAt: number;
  /** Output tokens so far this turn (status line). Reset when a turn starts. */
  tokens: TurnTokens;
  /** Token totals over the session's LIFE (the toolbar's `↓ 12.4k`, the
   *  launcher's meters, the cache %): the record's usage lines, as the agent
   *  sums them — refreshed on every step. */
  usage: TokenTotals;
  /** What the working line says in place of the phase: a retry in progress,
   *  a stop on its way. Null = the phase (thinking, writing, the tool). */
  caption: string | null;
  /** Finished (or failed) while you were looking somewhere else. */
  unseen: boolean;
  /** An agent's question about THIS session (the coding agent's "enter code
   *  mode?"), parked here — not on the window — so it shows only while this
   *  session is on screen and the answer lands on the session that asked. */
  ask: Dialog | null;
  /** Drives cycle order. 0 until the first message is sent. */
  lastMessageAt: number;
  /** Insertion counter — the tie-break while nothing has been said yet. */
  addedAt: number;
  /** Where this session's code stands. Null before the first poll lands. */
  workState: 'not_pushed' | 'not_merged' | 'merged' | null;
  /** The unsent text in the prompt when the user switched away from this
   *  session. Restored into the input box when returning. */
  draft: string;
  /** Parts buffered for the next paint, painted now. */
  flushParts: () => void;
  /** Stop listening to the agent — on close. */
  unwire: () => void;
}

/** Is someone else working in this session right now? The hold's expiry is a
 *  clock, and a turn that outruns it keeps streaming — so observed activity
 *  (parts arriving, no turn-end yet) counts too. THE one answer: the toolbar
 *  spinner, the esc-stop and the send guard all read this. */
export const activeHold = (entry: LoadedSession | undefined | null): LoadedSession['held'] =>
  entry?.held && (entry.held.expiresAt > Date.now() || entry.remoteBusy) ? entry.held : null;

export interface NewSession {
  id: string; branch: string; projectId: string;
  name?: string | null;
  card?: string;
  agent: CodingAgent;
  summary: ModelLine;
  /** The banner and the replayed conversation, already rendered to parts. */
  done?: Part[];
  planMode?: boolean;
  pinned?: boolean;
  syncStamp?: string | null;
  /** Text already in the prompt that belongs to THIS session (typed while
   *  /new was building it). Lands in the box the moment it opens. */
  draft?: string;
}

export class SessionStore {
  private entries: LoadedSession[] = [];
  private listeners = new Set<() => void>();
  private seq = 0;
  activeId = '';

  /** Words the agent handed back (its `returned` event): they drove a run
   *  that failed or was stopped before the model answered them, so they were
   *  never written. They go back where they were typed. */
  onReturned?: (id: string, text: string) => void;
  /** Fires after every turn settles (answered, failed or interrupted). The
   *  window's task-count refresh hangs off it. Best effort: never throws
   *  into a turn. */
  constructor(private onTurnEnd?: (entry: LoadedSession) => void) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void { for (const listener of [...this.listeners]) listener(); }

  get(id: string): LoadedSession | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  has(id: string): boolean { return this.entries.some((entry) => entry.id === id); }

  active(): LoadedSession | undefined { return this.get(this.activeId); }

  /** Every loaded session sorted for the tab ring and session list. Pinned
   *  sessions float to the top by recency among themselves, then the rest. */
  list(): LoadedSession[] {
    return [...this.entries].sort((a, b) => {
      const pinnedA = a.pinned && a.lastMessageAt > 0;
      const pinnedB = b.pinned && b.lastMessageAt > 0;
      if (pinnedA !== pinnedB) return pinnedB ? 1 : -1;
      return (b.lastMessageAt - a.lastMessageAt) || (b.addedAt - a.addedAt);
    });
  }

  /** Add and make active. Adding one you already have just activates it —
   *  /resume on a session that is already open must not open it twice. */
  add(fresh: NewSession): LoadedSession {
    const existing = this.get(fresh.id);
    if (existing) { this.activate(existing.id); return existing; }
    const entry: LoadedSession = {
      id: fresh.id, branch: fresh.branch, projectId: fresh.projectId, name: fresh.name ?? null, card: fresh.card,
      agent: fresh.agent, summary: fresh.summary,
      get busy() { return this.agent.busy; },
      get history() { return this.agent.session.messages; },
      turnOpen: false,
      done: [...(fresh.done ?? [])],
      planMode: fresh.planMode ?? false,
      pinned: fresh.pinned ?? false,
      syncStamp: fresh.syncStamp ?? null,
      live: [], turn: [],
      remoteBusy: false, held: null, startedAt: 0, tokens: NO_TOKENS,
      usage: { ...fresh.agent.session.usage }, caption: null,
      unseen: false, ask: null, lastMessageAt: fresh.agent.session.messages.length ? Date.now() : 0, addedAt: ++this.seq,
      workState: null, draft: fresh.draft ?? '',
      flushParts: () => undefined, unwire: () => undefined,
    };
    entry.unwire = this.wire(entry);
    this.entries.push(entry);
    this.activeId = entry.id;
    this.notify();
    return entry;
  }

  /** What the agent says, folded into the entry it was wired for. */
  private wire(entry: LoadedSession): () => void {
    const a = entry.agent;
    // Deltas arrive many times a second: buffered, flushed every FLUSH_MS;
    // any non-delta part flushes at once so ordering holds.
    let buf: StreamPart[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (buf.length) { const b = buf; buf = []; this.fold(entry, b); }
    };
    const offs = [
      a.on('turn-start', ({ model }) => {
        // The words were drawn when enter landed (say); only the clocks and
        // the model line are the turn-start's.
        entry.startedAt = Date.now();
        entry.tokens = NO_TOKENS;
        entry.caption = null;
        entry.lastMessageAt = Date.now();
        const line: ModelLine = { provider: model.provider, model: model.model, reasoning: model.reasoning ?? '' };
        if (line.provider !== entry.summary.provider || line.model !== entry.summary.model) {
          entry.summary = line;
          entry.done = [...entry.done, { kind: 'note', id: nextId('note'), text: `model → ${line.provider}/${line.model}` }];
        }
        this.notify();
      }),
      a.on('part', (part) => {
        // A failure is reported ONCE, through onError below; the stream's
        // own error part would be the same words twice.
        if (part.type === 'error') return;
        // A part arriving is the model answering: a retry caption is over.
        entry.caption = null;
        buf.push(part as StreamPart);
        const isDelta = part.type === 'text-delta' || part.type === 'reasoning-delta' || part.type === 'tool-input-delta';
        if (isDelta) { if (!timer) timer = setTimeout(flush, FLUSH_MS); }
        else flush();
      }),
      a.on('user-message', ({ texts }) => { flush(); entry.caption = null; this.userParts(entry, texts); this.notify(); }),
      // Words that never reached the record: off the conversation, back into
      // the box. A run that drew nothing leaves nothing to settle (no
      // elapsed line for a turn that never ran); the error, if any, was
      // already said once through onError.
      a.on('returned', ({ texts }) => {
        flush();
        this.unsay(entry, texts);
        if (!entry.turn.length) { entry.turnOpen = false; entry.startedAt = 0; }
        this.onReturned?.(entry.id, texts.join('\n\n'));
        this.notify();
      }),
      // Every step lands lines on the record: the totals and the stamp move
      // with it, so the screen is known to match what the server holds.
      a.on('step', ({ usage }) => { entry.usage = { ...usage }; entry.syncStamp = a.session.transcriptUpdatedAt; }),
      a.on('reloaded', ({ messages, from, now, added }) => {
        // The conversation gained messages this window had not drawn (the
        // server's queued user messages — a dropped file, a detached command
        // — or another writer's turn). A screen that already shows `now`
        // (the feed's record-landed repainted it) needs nothing; one that
        // matched `from` gains just the new messages; anything else is
        // redrawn whole.
        flush();
        if (entry.syncStamp === now) return;
        if (added && entry.syncStamp === from) {
          entry.done = [...entry.done, ...messagesToParts([...added])];
          entry.syncStamp = now;
          this.notify();
          return;
        }
        entry.syncStamp = now;
        this.repaint(entry, messages);
      }),
      // The turn's last parts. Settling waits for the agent to let go (say's
      // promise): turn-end fires while the agent still holds the turn, and a
      // screen settled here would show the residue under a spinner.
      a.on('turn-end', () => flush()),
    ];
    entry.flushParts = flush;
    return () => { flush(); for (const off of offs) off(); };
  }

  /** The agent's required handlers, for the window to hand `CodingAgent`
   *  when it opens a session. Errors reach the pane exactly once, here. */
  handlersFor(id: string): { onError(error: PhantomError): void; onNotice(notice: { type: string; text: string }): void } {
    return {
      onError: (err) => {
        const entry = this.get(id);
        if (!entry) return;
        if (err.code === 'session_locked') {
          // Refused before anything ran: the words come back on `returned`;
          // this is only the why.
          this.note(id, 'not sent — session in use elsewhere');
          return;
        }
        entry.turn = [...entry.turn, { kind: 'error', id: nextId('err'), message: err.message }];
        if (entry.id === this.activeId) this.notify();
        // A turn that failed sends no turn-end; it settles when the agent
        // lets go, behind say's promise, like every other ending.
      },
      onNotice: (notice) => {
        const entry = this.get(id);
        if (!entry) return;
        if (notice.type === 'retry') { entry.caption = notice.text; if (entry.id === this.activeId) this.notify(); return; }
        this.note(id, notice.text);
      },
    };
  }

  /** Words handed back, taken off the conversation: the last drawn user
   *  line for each, newest first — they were drawn when they were sent. */
  private unsay(entry: LoadedSession, texts: string[]): void {
    const done = [...entry.done];
    for (const text of [...texts].reverse()) {
      for (let i = done.length - 1; i >= 0; i--) {
        const part = done[i]!;
        if (part.kind === 'user' && part.text === text) { done.splice(i, 1); break; }
      }
    }
    entry.done = done;
  }

  /** The user's words, drawn where they were sent. */
  private userParts(entry: LoadedSession, texts: string[]): void {
    for (const text of texts) if (text.trim()) entry.done = [...entry.done, { kind: 'user', id: nextId('user'), text }];
  }

  /** The agent let go of the turn (say's promise settled — answered, failed
   *  or interrupted): `busy` is false NOW, so this is the one repaint that
   *  takes the spinner down and frees the prompt. A turn that ran draws its
   *  residue too: the live tail closes, the elapsed total stays as a line,
   *  the totals and the stamp take the record's. */
  private turnSettled(entry: LoadedSession): void {
    const ran = entry.turnOpen;
    entry.turnOpen = false;
    entry.caption = null;
    if (ran) {
      entry.flushParts();
      const rest = finalize(entry.turn);
      entry.turn = [];
      if (entry.startedAt) {
        const endedAt = Date.now();
        rest.push({ kind: 'worked', id: nextId('worked'), ms: endedAt - entry.startedAt, at: endedAt });
      }
      entry.done = [...entry.done, ...rest];
      entry.live = [];
      entry.usage = { ...entry.agent.session.usage };
      entry.syncStamp = entry.agent.session.transcriptUpdatedAt;
      // An error counts as something to come back to, same as an answer.
      if (entry.id !== this.activeId) entry.unseen = true;
    }
    this.notify();
    if (!ran) return;
    try { this.onTurnEnd?.(entry); }
    catch (err) { this.note(entry.id, `after the turn: ${(err as Error).message}`); }
  }

  /** Put an agent's question on the session it is about. One at a time per
   *  session — an agent awaits its answer, so a second cannot arrive while
   *  the first stands. */
  setAsk(id: string, dialog: Dialog): void {
    const entry = this.get(id);
    if (!entry) return;
    entry.ask = dialog;
    this.notify();
  }

  /** Take a session's question down and deliver its answer — enter's true,
   *  esc's false, `undefined` (or false) when its turn stopped. Cleared
   *  BEFORE the callback fires, as the window's dismissDialog does. */
  answerAsk = (id: string, result?: unknown): void => {
    const entry = this.get(id);
    if (!entry?.ask) return;
    const prev = entry.ask;
    entry.ask = null;
    prev.onDismiss(result);
    this.notify();
  };

  /** Switching to a session is how you read it, so its mark clears here. */
  activate(id: string): boolean {
    const entry = this.get(id);
    if (!entry || this.activeId === id) return false;
    this.activeId = id;
    entry.unseen = false;
    this.notify();
    return true;
  }

  /** Drop a session from THIS window: it leaves the tab ring, the open-session
   *  list and its dot in /resume. The server keeps everything — the row, the
   *  record, the files — so /resume opens it again unchanged; this is closing
   *  a tab, not deleting anything (that is [t]rash).
   *
   *  Refused while a turn is running here: stop the turn first (esc), then
   *  drop. */
  close(id: string): boolean {
    const entry = this.get(id);
    if (!entry || entry.agent.busy) return false;
    entry.unwire();
    void entry.agent.close();
    this.entries = this.entries.filter((entry) => entry.id !== id);
    // Dropping the one on screen leaves NOTHING on screen, deliberately: what
    // comes next is the App's call through switchTo (the one path that puts a
    // session in the pane).
    if (this.activeId === id) this.activeId = '';
    this.notify();
    return true;
  }

  /** The window's copy of the server name moves with /rename and with the
   *  staleness GET each landing makes. */
  setName(id: string, name: string | null): void {
    const entry = this.get(id);
    if (!entry || entry.name === name) return;
    entry.name = name;
    this.notify();
  }

  /** The next session round the ring, or undefined when there is nowhere to
   *  go. Sessions never spoken to are skipped — unless pinned. */
  next(dir: 1 | -1 = 1): LoadedSession | undefined {
    const order = this.list();
    if (order.length < 2) return undefined;
    const at = order.findIndex((entry) => entry.id === this.activeId);
    const count = order.length;
    let idx = at < 0 ? 0 : at;
    for (let i = 0; i < count - 1; i++) {
      idx = (idx + dir + count) % count;
      if (order[idx].lastMessageAt > 0 || order[idx].pinned) return order[idx];
    }
    return undefined;
  }

  setStamp(id: string, stamp: string | null): void {
    const entry = this.get(id);
    if (entry) entry.syncStamp = stamp;
  }

  setWorkState(id: string, workState: LoadedSession['workState']): void {
    const entry = this.get(id);
    if (entry && entry.workState !== workState) { entry.workState = workState; this.notify(); }
  }

  /** Another writer's record landed: the SCREEN takes the conversation as it
   *  stands. `parts` null keeps what is drawn (a turn this window watched
   *  whole over the feed is richer than a replay). The agent reads the
   *  record itself at its next turn start. */
  reseat(id: string, parts: Part[] | null, stamp: string | null, usage?: TokenTotals): void {
    const entry = this.get(id);
    if (!entry) return;
    if (parts) {
      entry.done = [...parts];
      entry.live = [];
      entry.turn = [];
    }
    entry.syncStamp = stamp;
    if (usage) entry.usage = usage;
    this.notify();
  }

  /** The conversation as the agent now holds it, drawn whole — after the
   *  agent re-read a record someone else moved. The banner (the first two
   *  notes) stays. */
  private repaint(entry: LoadedSession, messages: readonly ModelMessage[]): void {
    const banner = entry.done.slice(0, 2);
    entry.done = [...banner, { kind: 'note', id: nextId('note'), text: 'refreshed — this session moved forward elsewhere' },
      ...messagesToParts([...messages])];
    entry.live = [];
    entry.turn = [];
    this.notify();
  }

  // ── a turn someone ELSE is running, streamed here as it happens ───────────
  // The server publishes every part of a turn it runs; SessionFeed folds them
  // in through these three. Same renderer as a local turn.

  remoteStart(id: string, text: string): void {
    const entry = this.get(id);
    if (!entry || entry.agent.busy) return;
    entry.turn = [];
    entry.live = [];
    entry.remoteBusy = true;
    entry.startedAt = Date.now();
    entry.tokens = NO_TOKENS;
    if (text.trim()) entry.done = [...entry.done, { kind: 'user', id: nextId('user'), text }];
    this.notify();
  }

  remoteParts(id: string, parts: StreamPart[]): void {
    const entry = this.get(id);
    if (!entry || entry.agent.busy) return;
    if (!entry.remoteBusy) { entry.remoteBusy = true; entry.startedAt = Date.now(); entry.tokens = NO_TOKENS; }
    this.fold(entry, parts);
  }

  remoteEnd(id: string): void {
    const entry = this.get(id);
    if (!entry || entry.agent.busy) return;
    if (!entry.remoteBusy && !entry.turn.length) return;
    entry.remoteBusy = false;
    entry.usage.output += tokenCount(entry.tokens);
    const rest = finalize(entry.turn);
    entry.turn = [];
    entry.live = [];
    if (rest.length) entry.done = [...entry.done, ...rest];
    if (entry.id !== this.activeId) entry.unseen = true;
    this.notify();
  }

  /** The feed said who holds the session (or that nobody does). */
  setHeld(id: string, held: LoadedSession['held']): void {
    const entry = this.get(id);
    if (!entry) return;
    entry.held = held;
    this.notify();
  }

  note(id: string, text: string): void {
    const entry = this.get(id);
    if (!entry) return;
    entry.done = [...entry.done, { kind: 'note', id: nextId('note'), text }];
    this.notify();
  }

  /** Stop the running turn. What was typed meanwhile goes on with the same
   *  turn (the agent's rule); with nothing queued, esc just stops. The stop
   *  takes a few round trips to land (the cut step is recorded, the feed
   *  closed, the hold released), so the line says so at once. */
  abortTurn(id: string): void {
    const entry = this.get(id);
    if (!entry?.agent.busy) return;
    entry.agent.interrupt();
    entry.caption = entry.agent.userMessages.length ? 'sending what is queued' : 'stopping';
    if (entry.id === this.activeId) this.notify();
  }

  /** Say it: a turn starts if the session is free, otherwise it is queued
   *  behind the running turn and rides its next model call. The spinner
   *  starts the moment enter lands and stops when the agent lets go — the
   *  promise is the one signal for that: `busy` flips without an event, and
   *  turn-end fires before it flips. */
  say(id: string, text: string): void {
    const entry = this.get(id);
    if (!entry || !text.trim()) return;
    const starts = !entry.agent.busy;
    if (starts) {
      // Drawn NOW, as said — not when turn-start lands a round trip later.
      // What was queued goes with it (the agent drains the queue into the
      // turn it opens), so it leaves the queued list for the conversation.
      this.userParts(entry, [...entry.agent.userMessages.pending().map((queued) => queued.text), text]);
      entry.turnOpen = true;
      entry.startedAt = Date.now();
      entry.tokens = NO_TOKENS;
    }
    // Every failure reaches the pane through onError, once; the promise is
    // only awaited for its end.
    const sent = entry.agent.sendMessage(text).catch(() => undefined);
    if (starts) void sent.then(() => this.turnSettled(entry));
    this.notify();
  }

  /** Drop everything queued — `/pop all`. */
  clearQueue(id: string): void {
    const entry = this.get(id);
    if (!entry || !entry.agent.userMessages.length) return;
    entry.agent.userMessages.clear();
    this.notify();
  }

  /** Take the last queued message back — `/pop`. */
  unqueue(id: string): string | undefined {
    const entry = this.get(id);
    if (!entry || !entry.agent.userMessages.length) return undefined;
    const last = entry.agent.userMessages.pending().at(-1)!;
    const taken = entry.agent.userMessages.take(last.id);
    this.notify();
    return taken?.text;
  }

  /** Every turn, everywhere — what quitting does first. The queue stays:
   *  nothing queued may start another model loop on the way out. */
  abortAll(): void { for (const entry of this.entries) entry.agent.interrupt({ keepQueue: true }); }

  /** Every agent closed: each turn interrupted and waited out, so every
   *  turn-ended reaches the server before the process goes. */
  closeAll(): Promise<void> {
    return Promise.all(this.entries.map((entry) => { entry.unwire(); return entry.agent.close(); })).then(() => undefined);
  }

  setPinned(id: string, on: boolean): void {
    const entry = this.get(id);
    if (!entry || entry.pinned === on) return;
    entry.pinned = on;
    this.notify();
  }

  /** /plan flipped (here or elsewhere): the toolbar's mirror. The agent
   *  reads the row at turn start and hears a mid-turn flip off the feed. */
  setPlanMode(id: string, on: boolean): void {
    const entry = this.get(id);
    if (!entry || entry.planMode === on) return;
    entry.planMode = on;
    this.notify();
  }

  /** The banner's model line moved on the server (a settings change reached
   *  a session nothing has been said to yet). */
  setModelLine(id: string, line: ModelLine): void {
    const entry = this.get(id);
    if (!entry || (entry.summary.provider === line.provider && entry.summary.model === line.model && entry.summary.reasoning === line.reasoning)) return;
    entry.summary = line;
    this.note(id, `model → ${line.provider}/${line.model}`);
  }

  /** Fold a flush of stream parts into the entry that produced them. */
  private fold(entry: LoadedSession, parts: StreamPart[]): void {
    let turn = entry.turn;
    let tokens = entry.tokens;
    for (const part of parts) {
      turn = applyPart(turn, part);
      tokens = applyTokens(tokens, part);
    }
    entry.tokens = tokens;
    const split = takeCompleted(turn);
    entry.turn = split.live;
    if (split.done.length) entry.done = [...entry.done, ...split.done];
    entry.live = split.live;
    if (entry.id === this.activeId) this.notify();
  }
}

export type { AgentStreamPart };
