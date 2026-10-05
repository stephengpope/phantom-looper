import { normalizeKey } from '@phantom-agent-sdk/client';
import { followStream, type Stream } from './follow.js';

// The kanban board's one store. Everything that changes the board — keyboard,
// mouse drag, the Assistant's `kanban` tool — calls the same methods on the
// same instance, so the screen (which renders from it and subscribes) updates
// no matter who made the edit. Writes are optimistic: apply locally, notify,
// send to the server, reload on error. The server owns the truth
// (/projects/:id/cards), and every write to it from anywhere — the looper,
// the supervisor, another window — comes back down its event stream
// (`follow`) and is adopted here the same way, so the board is always
// current and nothing polls.
// key is the item's permanent handle (server-assigned; kanban_card_tick names
// items by it). Optional in TS only because an item the editor just typed has
// none yet — the server assigns on save.
export interface CardStep { key?: string; text: string; done: boolean }
export interface ItemOp { op: 'add' | 'edit' | 'remove' | 'tick'; key?: string; text?: string; done?: boolean }
export interface Card {
  id: number; number: number; status: string; pos: number;
  title: string; details: string;
  requirements: CardStep[];
  blocked_reason: string | null; resolution?: string | null;
  auto_plan: boolean | null; auto_build: boolean | null;
  pinned: boolean; archived: boolean;
  created_at: string; updated_at: string;
}
/** THE card patch — every field a client may write, in one place. update()
 *  takes it and the card editor's diff RETURNS it, so a field the editor
 *  sends but the store cannot carry is a compile error, not a silent drop
 *  (the editor's status corner would otherwise pin on "saving…" forever). */
export type CardPatch = Partial<Pick<Card, 'title' | 'details' | 'status' | 'pos'
  | 'requirements' | 'blocked_reason' | 'resolution' | 'auto_plan' | 'auto_build' | 'pinned' | 'archived'>>;

/** A card's current loop's coding session — who is (or was) building it. */
export interface CardSession { id: string; name: string | null }
export interface BoardState {
  prefix: string; columns: string[]; cards: Card[]; loaded: boolean; project?: string; error?: string;
  /** By card number: the CURRENT loop's coding session, from the board GET.
   *  Absent number = the card never entered the loop. */
  sessions?: Record<number, CardSession>;
  /** By card number: the git work state (not_pushed / not_merged / merged),
   *  from the card's coding session row. Absent = no session or never checked. */
  cardWorkState?: Record<number, string>;
  /** By card number: WHEN the card's coding session was seen to start running
   *  (epoch ms), so the board can age a turn as well as show one. Absent number =
   *  not locked or no session. A turn that has run a long time is the thing a
   *  person needs to notice, so the value is a clock, not a flag. */
  cardLocked?: Record<number, number>;
  /** The project's resolved auto_plan / auto_build — what an `inherit` card
   *  actually gets — and which layer said so ('default' | 'global' | 'project'). */
  autoPlanDefault?: boolean; autoPlanSource?: string;
  autoBuildDefault?: boolean; autoBuildSource?: string;
}

export type { Api } from './request.js';
import type { Api } from './request.js';
// The follow policy (reconnect, backoff, the stall watchdog) is follow.ts —
// shared with the session feed, so there is one copy of it.
export { STREAM_STALL_MS, type Stream } from './follow.js';

export class BoardStore {
  state: BoardState = { prefix: '', columns: [], cards: [], loaded: false };
  private listeners = new Set<() => void>();
  private following: AbortController | null = null;

  constructor(private api: Api, readonly projectId: string, private stream?: Stream) {}

  /** Follow the project's event stream for the life of the store: each
   *  record is adopted like the store's own edits (a card written anywhere
   *  replaces its copy; a delete drops it; a loop pairing fills the Session
   *  row). The link is re-opened whenever it drops, with a full load after
   *  each reconnect to cover what was missed — the only reload the store
   *  ever makes on its own. No stream wired = nothing to follow. */
  follow(): void {
    if (!this.stream || this.following) return;
    const abort = new AbortController();
    this.following = abort;
    void followStream(this.stream, `/projects/${this.projectId}/events`, abort.signal, {
      onRecord: (rec) => this.applyEvent(rec),
      onReconnect: () => this.load(),   // records were missed — refill the board
    });
  }
  close(): void { this.following?.abort(); this.following = null; }

  /** One record off the stream — the server's BoardEvent shapes. */
  applyEvent(rec: Record<string, unknown>): void {
    if (rec.event === 'card' && rec.card) this.adoptCard(rec.card as Card);
    else if (rec.event === 'deleted') {
      const id = Number(rec.id);
      if (!this.state.cards.some((card) => card.id === id)) return;
      this.state = { ...this.state, cards: this.state.cards.filter((card) => card.id !== id) };
      this.notify();
    } else if (rec.event === 'session') {
      // The loop pairing — the ONE speaker for a card's session and its name.
      const card = Number(rec.card);
      const sessions = { ...(this.state.sessions ?? {}), [card]: { id: String(rec.id), name: (rec.name as string | null) ?? null } };
      this.state = { ...this.state, sessions };
      this.notify();
    } else if (rec.event === 'session_lock') {
      const card = Number(rec.card);
      const cardLocked = { ...(this.state.cardLocked ?? {}) };
      // Keep the ORIGINAL start across repeats: the lock event repeats on
      // renewal and on reconnect, and restamping each time would reset the age
      // of a turn that has been running for an hour.
      if (rec.locked === true) cardLocked[card] ??= Date.now();
      else if (rec.locked === false) delete cardLocked[card];
      this.state = { ...this.state, cardLocked };
      this.notify();
    } else if (rec.event === 'session_work_state') {
      const card = Number(rec.card);
      const cardWorkState = { ...(this.state.cardWorkState ?? {}) };
      if (rec.workState != null) cardWorkState[card] = String(rec.workState);
      this.state = { ...this.state, cardWorkState };
      this.notify();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify(): void { for (const listener of [...this.listeners]) listener(); }

  /** Cards of one column, in board order: the pinned group first, pos still
   *  sorting inside each group. */
  cardsIn(status: string): Card[] {
    return this.state.cards.filter((card) => card.status === status && !card.archived)
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.pos - b.pos || a.id - b.id);
  }
  /** Find by the number people use ("7" of PHA-7). */
  byNumber(number: number): Card | undefined { return this.state.cards.find((card) => card.number === number); }
  /** The number of a card held by id — state is keyed by id, the routes by
   *  number (PHA-7 is card 7). */
  private numberOf(id: number): number | undefined { return this.state.cards.find((card) => card.id === id)?.number; }

  /** One card by number, straight from the server — archived or not. The
   *  board GET excludes archived cards, so a miss on byNumber comes here
   *  ("restore card 7", /archived's editor). The answer is adopted into
   *  state (cardsIn filters archived, so the board is untouched);
   *  undefined = no such card. */
  async fetchCard(number: number): Promise<Card | undefined> {
    const reply = await this.api('GET', `/projects/${this.projectId}/cards?number=${number}`) as Record<string, unknown>;
    const card = (reply.cards as Card[] | undefined)?.[0];
    if (!card) return undefined;
    this.adoptCard(card);
    return this.state.cards.find((card) => card.id === card.id);
  }

  /** Seat one server-fetched card in state (replacing any copy of it) — the
   *  off-board entry path fetchCard and /archived's open use. */
  adoptCard(card: Card): void {
    const fresh = { ...card };
    this.state = { ...this.state, cards: [...this.state.cards.filter((card) => card.id !== fresh.id), fresh] };
    this.notify();
  }

  /** "Open card 7" / "expand the plan column" / "show the board": the
   *  Assistant asks through the store, the Board consumes it once it has
   *  data — open that card's edit screen; expand that one column to the full
   *  width; or 'board' = every column, no editor, nothing expanded. One
   *  mailbox, one consumer: the latest request wins. */
  requested: { column: string } | 'board' | null = null;
  requestColumn(column: string): void { this.requested = { column }; this.notify(); }
  requestBoard(): void { this.requested = 'board'; this.notify(); }
  consumeRequested(): { column: string } | 'board' | undefined {
    if (this.requested == null) return undefined;
    const req = this.requested;
    this.requested = null;
    return req;
  }

  async load(): Promise<void> {
    try {
      const reply = await this.api('GET', `/projects/${this.projectId}/cards`) as Record<string, unknown>;
      const sessions: Record<number, CardSession> = {};
      for (const cardSession of (reply.card_sessions as { card: number; id: string; name: string | null }[] | undefined) ?? [])
        sessions[cardSession.card] = { id: cardSession.id, name: cardSession.name };
      // The board GET excludes archived cards, so absence from the response
      // says nothing about a card this store learned of by number (fetchCard —
      // an open archived card's editor): those survive a reload (the one
      // after a reconnect), or it would close the editor mid-edit. A card restored elsewhere
      // arrives in `fresh` unarchived and replaces its kept copy.
      const fresh = reply.cards as Card[];
      const kept = this.state.cards.filter((card) => card.archived && !fresh.some((fresh) => fresh.id === card.id));
      const cardWorkState: Record<number, string> = {};
      for (const [card, value] of Object.entries((reply.card_work_state as Record<string, string | null> | undefined) ?? {}))
        if (value) cardWorkState[Number(card)] = value;
      const cardLocked: Record<number, number> = {};
      for (const [card, value] of Object.entries((reply.card_locked as Record<string, boolean> | undefined) ?? {}))
        // A refresh cannot know when a turn began — only that it is running.
        // Keep any start we already had; otherwise start the clock now.
        if (value) cardLocked[Number(card)] = this.state.cardLocked?.[Number(card)] ?? Date.now();
      this.state = { prefix: String(reply.prefix), columns: reply.columns as string[],
        cards: [...fresh, ...kept], loaded: true, sessions, cardWorkState, cardLocked,
        project: reply.project ? String(reply.project) : undefined,
        autoPlanDefault: Boolean(reply.auto_plan_default),
        autoPlanSource: reply.auto_plan_source ? String(reply.auto_plan_source) : undefined,
        autoBuildDefault: Boolean(reply.auto_build_default),
        autoBuildSource: reply.auto_build_source ? String(reply.auto_build_source) : undefined };
    } catch (step) {
      this.state = { ...this.state, loaded: true, error: (step as Error).message };
    }
    this.notify();
  }

  async create(fields: { title: string } & Partial<Pick<Card,
    'status' | 'details' | 'requirements'>>): Promise<Card> {
    // Server-first: it assigns number and pos. One round-trip, then on screen.
    // The server publishes the new row on the event stream BEFORE it answers
    // this POST, so the card is usually already here by the time the answer
    // lands — seat it (replace by id), never append, or the board shows two.
    const reply = await this.api('POST', `/projects/${this.projectId}/cards`, fields) as Record<string, unknown>;
    const card = reply.card as Card;
    this.adoptCard(card);
    return card;
  }

  /** Optimistic; on a server reject the board reverts AND the caller gets the
   *  message back (null = it stuck) — a tool must report the failure, not
   *  `ok`. UI callers fire-and-forget and just see the revert. */
  async update(id: number, patch: CardPatch): Promise<string | null> {
    const number = this.numberOf(id);
    if (number === undefined) return `no card ${id} on the board`;
    const before = this.state;
    this.state = { ...this.state, cards: this.state.cards.map((card) => card.id === id ? { ...card, ...patch } : card) };
    this.notify();
    try {
      const reply = await this.api('PATCH', `/projects/${this.projectId}/cards/${number}`, patch) as Record<string, unknown>;
      this.adopt(reply.card as Card | undefined);
      return null;
    }
    catch (step) {
      this.state = { ...before, error: (step as Error).message }; this.notify();
      await this.load();
      return (step as Error).message;
    }
  }

  /** The server's answer replaces the optimistic guess — it holds what only
   *  the server decides (keys assigned to new checklist items, updated_at).
   *  Cloned: an api client may hand back an object it also mutates in place,
   *  and a same-reference card prop skips React effects (the CardEditor's
   *  rebase compares by content but only when the effect fires at all). */
  private adopt(card: Card | undefined): void {
    if (!card) return;
    const fresh = { ...card };
    this.state = { ...this.state, cards: this.state.cards.map((card) => card.id === fresh.id ? fresh : card) };
    this.notify();
  }

  /** Item ops (add/edit/remove/tick) by key — the server changes only the
   *  named items, so no op can wipe a list. Same optimistic shape as update;
   *  an added item shows at once with a placeholder key and the server's
   *  answer (its real key) replaces it via adopt(). Key matching is
   *  case-forgiving, same as the server, or an op lands there but the open
   *  board does not repaint. */
  async items(id: number, ops: ItemOp[]): Promise<string | null> {
    const number = this.numberOf(id);
    if (number === undefined) return `no card ${id} on the board`;
    const before = this.state;
    const apply = (card: Card): Card => {
      const next = { ...card, requirements: [...card.requirements] };
      for (const operation of ops) {
        const hit = (step: CardStep) => step.key !== undefined && operation.key !== undefined
          && normalizeKey(step.key) === normalizeKey(operation.key);
        if (operation.op === 'add') next.requirements = [...next.requirements, { text: operation.text ?? '', done: operation.done ?? false }];
        else if (operation.op === 'remove') next.requirements = next.requirements.filter((step) => !hit(step));
        else next.requirements = next.requirements.map((step) => !hit(step) ? step
          : { ...step, ...(operation.op === 'edit' && operation.text !== undefined ? { text: operation.text } : {}), ...(operation.done !== undefined ? { done: operation.done } : {}) });
      }
      return next;
    };
    this.state = { ...this.state, cards: this.state.cards.map((card) => card.id === id ? apply(card) : card) };
    this.notify();
    try {
      const reply = await this.api('PATCH', `/projects/${this.projectId}/cards/${number}`, { items: ops }) as Record<string, unknown>;
      this.adopt(reply.card as Card | undefined);
      return null;
    }
    catch (step) {
      this.state = { ...before, error: (step as Error).message }; this.notify();
      await this.load();
      return (step as Error).message;
    }
  }

  /** A card's revision history, newest first — read-through, touches no
   *  state. By number straight to the server: an archived card is not on
   *  the board and its history still answers. */
  async revisions(number: number, limit?: number): Promise<unknown[]> {
    const reply = await this.api('GET', `/projects/${this.projectId}/cards/${number}/revisions` +
      (limit !== undefined ? `?limit=${limit}` : '')) as Record<string, unknown>;
    return reply.revisions as unknown[];
  }

  /** Move to a column at a row: pos is the midpoint of the new neighbours. */
  async move(id: number, status: string, row: number): Promise<string | null> {
    const col = this.cardsIn(status).filter((card) => card.id !== id);
    const before = col[row - 1]?.pos;
    const after = col[row]?.pos;
    const pos = before !== undefined && after !== undefined ? (before + after) / 2
      : before !== undefined ? before + 1
      : after !== undefined ? after - 1 : 1;
    return this.update(id, { status, pos });
  }
}
