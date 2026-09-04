import { normalizeKey } from '../core/kanban.js';
import { followStream, type Stream } from './follow.js';

// The kanban board's one store. Everything that changes the board — keyboard,
// mouse drag, the Assistant's `kanban` tool — calls the same methods on the
// same instance, so the screen (which renders from it and subscribes) updates
// no matter who made the edit. Writes are optimistic: apply locally, notify,
// send to the server, reload on error. The server owns the truth
// (/workspaces/:id/cards), and every write to it from anywhere — the looper,
// the supervisor, another window — comes back down its event stream
// (`follow`) and is adopted here the same way, so the board is always
// current and nothing polls.
// key is the item's permanent handle (server-assigned; kanban_card_tick names
// items by it). Optional in TS only because an item the editor just typed has
// none yet — the server assigns on save.
export interface CardStep { key?: string; text: string; done: boolean }
export interface ItemOp { op: 'add' | 'edit' | 'remove' | 'tick'; key?: string; text?: string; done?: boolean }
export interface Card {
  id: number; seq: number; status: string; pos: number;
  title: string; details: string; user_story: string;
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
export type CardPatch = Partial<Pick<Card, 'title' | 'details' | 'user_story' | 'status' | 'pos'
  | 'requirements' | 'blocked_reason' | 'resolution' | 'auto_plan' | 'auto_build' | 'pinned' | 'archived'>>;

/** A card's current loop's coding session — who is (or was) building it. */
export interface CardSession { id: string; name: string | null }
export interface BoardState {
  prefix: string; columns: string[]; cards: Card[]; loaded: boolean; workspace?: string; error?: string;
  /** By card seq: the CURRENT loop's coding session, from the board GET.
   *  Absent seq = the card never entered the loop. */
  sessions?: Record<number, CardSession>;
  /** The workspace's resolved auto_plan / auto_build — what an `inherit` card
   *  actually gets — and which layer said so ('default' | 'global' | 'workspace'). */
  autoPlanDefault?: boolean; autoPlanSource?: string;
  autoBuildDefault?: boolean; autoBuildSource?: string;
}

export type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;
// The follow policy (reconnect, backoff, the stall watchdog) is follow.ts —
// shared with the session feed, so there is one copy of it.
export { STREAM_STALL_MS, type Stream } from './follow.js';

export class BoardStore {
  state: BoardState = { prefix: '', columns: [], cards: [], loaded: false };
  private listeners = new Set<() => void>();
  private following: AbortController | null = null;

  constructor(private api: Api, readonly workspaceId: string, private stream?: Stream) {}

  /** Follow the workspace's event stream for the life of the store: each
   *  record is adopted like the store's own edits (a card written anywhere
   *  replaces its copy; a delete drops it; a loop pairing fills the Session
   *  row). The link is re-opened whenever it drops, with a full load after
   *  each reconnect to cover what was missed — the only reload the store
   *  ever makes on its own. No stream wired = nothing to follow. */
  follow(): void {
    if (!this.stream || this.following) return;
    const ac = new AbortController();
    this.following = ac;
    void followStream(this.stream, `/workspaces/${this.workspaceId}/events`, ac.signal, {
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
      if (!this.state.cards.some((t) => t.id === id)) return;
      this.state = { ...this.state, cards: this.state.cards.filter((t) => t.id !== id) };
      this.notify();
    } else if (rec.event === 'session') {
      const sessions = { ...(this.state.sessions ?? {}), [Number(rec.card)]: { id: String(rec.id), name: (rec.name as string | null) ?? null } };
      this.state = { ...this.state, sessions };
      this.notify();
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private notify(): void { for (const l of [...this.listeners]) l(); }

  /** Cards of one column, in board order: the pinned group first, pos still
   *  sorting inside each group. */
  cardsIn(status: string): Card[] {
    return this.state.cards.filter((t) => t.status === status && !t.archived)
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.pos - b.pos || a.id - b.id);
  }
  /** Find by the number people use ("7" of PHA-7). */
  bySeq(seq: number): Card | undefined { return this.state.cards.find((t) => t.seq === seq); }

  /** One card by number, straight from the server — archived or not. The
   *  board GET excludes archived cards, so a miss on bySeq comes here
   *  ("restore card 7", /archived's editor). The answer is adopted into
   *  state (cardsIn filters archived, so the board is untouched);
   *  undefined = no such card. */
  async fetchCard(seq: number): Promise<Card | undefined> {
    const d = await this.api('GET', `/workspaces/${this.workspaceId}/cards?seq=${seq}`) as Record<string, unknown>;
    const card = (d.cards as Card[] | undefined)?.[0];
    if (!card) return undefined;
    this.adoptCard(card);
    return this.state.cards.find((t) => t.id === card.id);
  }

  /** Seat one server-fetched card in state (replacing any copy of it) — the
   *  off-board entry path fetchCard and /archived's open use. */
  adoptCard(card: Card): void {
    const fresh = { ...card };
    this.state = { ...this.state, cards: [...this.state.cards.filter((t) => t.id !== fresh.id), fresh] };
    this.notify();
  }

  /** "Open card 7" / "expand the plan column" / "show the board": the
   *  Assistant asks through the store, the Board consumes it once it has
   *  data — open that card's edit screen; expand that one column to the full
   *  width; or 'board' = every column, no editor, nothing expanded. One
   *  mailbox, one consumer: the latest request wins. */
  requested: { card: number } | { column: string } | 'board' | null = null;
  requestCard(seq: number): void { this.requested = { card: seq }; this.notify(); }
  requestColumn(column: string): void { this.requested = { column }; this.notify(); }
  requestBoard(): void { this.requested = 'board'; this.notify(); }
  consumeRequested(): { card: Card } | { column: string } | 'board' | undefined {
    if (this.requested == null) return undefined;
    const req = this.requested;
    this.requested = null;
    if (req === 'board') return 'board';
    if ('column' in req) return req;
    const card = this.bySeq(req.card);
    return card ? { card } : undefined;
  }

  async load(): Promise<void> {
    try {
      const d = await this.api('GET', `/workspaces/${this.workspaceId}/cards`) as Record<string, unknown>;
      const sessions: Record<number, CardSession> = {};
      for (const s of (d.card_sessions as { card: number; id: string; name: string | null }[] | undefined) ?? [])
        sessions[s.card] = { id: s.id, name: s.name };
      // The board GET excludes archived cards, so absence from the response
      // says nothing about a card this store learned of by seq (fetchCard —
      // an open archived card's editor): those survive a reload (the one
      // after a reconnect), or it would close the editor mid-edit. A card restored elsewhere
      // arrives in `fresh` unarchived and replaces its kept copy.
      const fresh = d.cards as Card[];
      const kept = this.state.cards.filter((t) => t.archived && !fresh.some((f) => f.id === t.id));
      this.state = { prefix: String(d.prefix), columns: d.columns as string[],
        cards: [...fresh, ...kept], loaded: true, sessions,
        workspace: d.workspace ? String(d.workspace) : undefined,
        autoPlanDefault: Boolean(d.auto_plan_default),
        autoPlanSource: d.auto_plan_source ? String(d.auto_plan_source) : undefined,
        autoBuildDefault: Boolean(d.auto_build_default),
        autoBuildSource: d.auto_build_source ? String(d.auto_build_source) : undefined };
    } catch (e) {
      this.state = { ...this.state, loaded: true, error: (e as Error).message };
    }
    this.notify();
  }

  async create(fields: { title: string } & Partial<Pick<Card,
    'status' | 'details' | 'user_story' | 'requirements'>>): Promise<Card> {
    // Server-first: it assigns seq and pos. One round-trip, then on screen.
    // The server publishes the new row on the event stream BEFORE it answers
    // this POST, so the card is usually already here by the time the answer
    // lands — seat it (replace by id), never append, or the board shows two.
    const d = await this.api('POST', `/workspaces/${this.workspaceId}/cards`, fields) as Record<string, unknown>;
    const card = d.card as Card;
    this.adoptCard(card);
    return card;
  }

  /** Optimistic; on a server reject the board reverts AND the caller gets the
   *  message back (null = it stuck) — a tool must report the failure, not
   *  `ok`. UI callers fire-and-forget and just see the revert. */
  async update(id: number, patch: CardPatch): Promise<string | null> {
    const before = this.state;
    this.state = { ...this.state, cards: this.state.cards.map((t) => t.id === id ? { ...t, ...patch } : t) };
    this.notify();
    try {
      const d = await this.api('PATCH', `/workspaces/${this.workspaceId}/cards/${id}`, patch) as Record<string, unknown>;
      this.adopt(d.card as Card | undefined);
      return null;
    }
    catch (e) {
      this.state = { ...before, error: (e as Error).message }; this.notify();
      await this.load();
      return (e as Error).message;
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
    this.state = { ...this.state, cards: this.state.cards.map((t) => t.id === fresh.id ? fresh : t) };
    this.notify();
  }

  /** Item ops (add/edit/remove/tick) by key — the server changes only the
   *  named items, so no op can wipe a list. Same optimistic shape as update;
   *  an added item shows at once with a placeholder key and the server's
   *  answer (its real key) replaces it via adopt(). Key matching is
   *  case-forgiving, same as the server, or an op lands there but the open
   *  board does not repaint. */
  async items(id: number, ops: ItemOp[]): Promise<string | null> {
    const before = this.state;
    const apply = (t: Card): Card => {
      const next = { ...t, requirements: [...t.requirements] };
      for (const o of ops) {
        const hit = (e: CardStep) => e.key !== undefined && o.key !== undefined
          && normalizeKey(e.key) === normalizeKey(o.key);
        if (o.op === 'add') next.requirements = [...next.requirements, { text: o.text ?? '', done: o.done ?? false }];
        else if (o.op === 'remove') next.requirements = next.requirements.filter((e) => !hit(e));
        else next.requirements = next.requirements.map((e) => !hit(e) ? e
          : { ...e, ...(o.op === 'edit' && o.text !== undefined ? { text: o.text } : {}), ...(o.done !== undefined ? { done: o.done } : {}) });
      }
      return next;
    };
    this.state = { ...this.state, cards: this.state.cards.map((t) => t.id === id ? apply(t) : t) };
    this.notify();
    try {
      const d = await this.api('PATCH', `/workspaces/${this.workspaceId}/cards/${id}`, { items: ops }) as Record<string, unknown>;
      this.adopt(d.card as Card | undefined);
      return null;
    }
    catch (e) {
      this.state = { ...before, error: (e as Error).message }; this.notify();
      await this.load();
      return (e as Error).message;
    }
  }

  /** A card's revision history, newest first — read-through, touches no
   *  state. By seq, not id: a deleted card is not on the board, and reading
   *  one that is gone is the point. */
  async revisions(seq: number, limit?: number): Promise<unknown[]> {
    const d = await this.api('GET', `/workspaces/${this.workspaceId}/revisions?card=${seq}` +
      (limit !== undefined ? `&limit=${limit}` : '')) as Record<string, unknown>;
    return d.revisions as unknown[];
  }

  /** Move to a column at a row: pos is the midpoint of the new neighbours. */
  async move(id: number, status: string, row: number): Promise<string | null> {
    const col = this.cardsIn(status).filter((t) => t.id !== id);
    const before = col[row - 1]?.pos;
    const after = col[row]?.pos;
    const pos = before !== undefined && after !== undefined ? (before + after) / 2
      : before !== undefined ? before + 1
      : after !== undefined ? after - 1 : 1;
    return this.update(id, { status, pos });
  }
}
