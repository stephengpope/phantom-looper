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
import type { PhantomError, StreamPart as AgentStreamPart, TokenTotals } from 'phantom-client-sdk';
import type { CodingAgent } from '../core/agents/coding.js';
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
  /** The caption under the spinner while the model is being retried. */
  caption: string | null;
  /** The words a send is carrying until turn-start lands — put back in the
   *  box if the session turns out to be held elsewhere. */
  sending: string | null;
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

  /** The send was refused before anything ran (session held elsewhere, the
   *  server unreachable): the words go back where they were typed. */
  onRefused?: (id: string, text: string) => void;
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
      usage: { ...fresh.agent.session.usage }, caption: null, sending: null,
      unseen: false, ask: null, lastMessageAt: fresh.agent.session.messages.length ? Date.now() : 0, addedAt: ++this.seq,
      workState: null, draft: fresh.draft ?? '',
      unwire: () => undefined,
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
      a.on('turn-start', ({ texts, model }) => {
        entry.sending = null;
        entry.startedAt = Date.now();
        entry.tokens = NO_TOKENS;
        entry.caption = null;
        entry.lastMessageAt = Date.now();
        this.userParts(entry, texts);
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
        buf.push(part as StreamPart);
        const isDelta = part.type === 'text-delta' || part.type === 'reasoning-delta' || part.type === 'tool-input-delta';
        if (isDelta) { if (!timer) timer = setTimeout(flush, FLUSH_MS); }
        else flush();
      }),
      a.on('user-message', ({ texts }) => { flush(); this.userParts(entry, texts); this.notify(); }),
      a.on('step', ({ usage }) => { entry.usage = { ...usage }; }),
      a.on('reloaded', ({ messages }) => {
        // Another writer moved the record; the agent re-read it. The pane
        // shows the conversation as it stands now.
        flush();
        this.repaint(entry, messages);
      }),
      a.on('turn-end', () => {
        flush();
        this.turnSettled(entry);
      }),
    ];
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
          // Refused before anything ran: the session goes idle again, the
          // words go back into the box, and the note says why.
          const text = entry.sending;
          entry.sending = null;
          entry.turnOpen = false;
          entry.startedAt = 0;
          this.note(id, 'not sent — session in use elsewhere');
          if (text) this.onRefused?.(id, text);
          setTimeout(() => this.notify(), 0);   // the agent lets go a tick after it told us
          return;
        }
        entry.turn = [...entry.turn, { kind: 'error', id: nextId('err'), message: err.message }];
        if (entry.id === this.activeId) this.notify();
        // A turn that failed sends no turn-end: settle it once the agent has
        // let go (it tells us before its own promise settles).
        setTimeout(() => { if (entry.turnOpen && !entry.agent.busy) this.turnSettled(entry); }, 0);
      },
      onNotice: (notice) => {
        const entry = this.get(id);
        if (!entry) return;
        if (notice.type === 'retry') { entry.caption = notice.text; if (entry.id === this.activeId) this.notify(); return; }
        this.note(id, notice.text);
      },
    };
  }

  /** The user's words, drawn where they were sent. */
  private userParts(entry: LoadedSession, texts: string[]): void {
    for (const text of texts) if (text.trim()) entry.done = [...entry.done, { kind: 'user', id: nextId('user'), text }];
  }

  /** The turn is over, however it ended: the live tail closes, the elapsed
   *  total stays as a line, the totals take the record's sums. */
  private turnSettled(entry: LoadedSession): void {
    if (!entry.turnOpen) return;
    entry.turnOpen = false;
    const rest = finalize(entry.turn);
    entry.turn = [];
    if (entry.startedAt) {
      const endedAt = Date.now();
      rest.push({ kind: 'worked', id: nextId('worked'), ms: endedAt - entry.startedAt, at: endedAt });
    }
    entry.done = [...entry.done, ...rest];
    entry.live = [];
    entry.caption = null;
    entry.sending = null;
    entry.usage = { ...entry.agent.session.usage };
    // An error counts as something to come back to, same as an answer.
    if (entry.id !== this.activeId) entry.unseen = true;
    this.notify();
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
   *  turn (the agent's rule); with nothing queued, esc just stops. */
  abortTurn(id: string): void { this.get(id)?.agent.interrupt(); }

  /** Say it: a turn starts if the session is free, otherwise it is queued
   *  behind the running turn and rides its next model call. The spinner
   *  starts the moment enter lands. */
  say(id: string, text: string): void {
    const entry = this.get(id);
    if (!entry || !text.trim()) return;
    if (!entry.agent.busy) {
      entry.sending = text;
      entry.turnOpen = true;
      entry.startedAt = Date.now();
      entry.tokens = NO_TOKENS;
    }
    // Never awaited: every failure reaches the pane through onError, once.
    void entry.agent.sendMessage(text).catch(() => undefined);
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

  /** Every turn, everywhere — what quitting does first. */
  abortAll(): void { for (const entry of this.entries) entry.agent.interrupt(); }

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
