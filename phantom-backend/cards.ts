// The card's one owner. Cards live in ONE table (phantom_looper.cards, 024),
// addressed by workspace id; this is the only file that queries it. Every
// card write publishes on the board bus with the write, so a listener
// anywhere sees it — the cli's board, the looper, Telegram — and no route has
// to remember to say so.
//
// The rules that used to live in the route live here: the column a card may
// sit in, THE field list (create, update and the API schema all derive from
// it), how checklist items are edited by key, and what a move publishes.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './db/client.js';
// `sessions` is here for ONE read: the card a session works on is a join on
// sessions.card_id. Read through the join only; the row is Sessions' to write.
import { cards, cardRevisions, sessions, type CardRow, type WorkspaceRow } from './db/schema.js';
import { columnsOf, type Workspaces } from './workspaces.js';
import { keyedItems, newKey, normalizeKey, type ChecklistItem } from '../core/kanban.js';
import type { BoardEvents } from './api/boardEvents.js';

export type { CardRow };

export class CardError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_args', message: string) { super(message); }
}

/** THE card field list — create, update, and the API schema all derive from
 *  it. It was three hand-kept lists once; create's copy silently lacked
 *  `supervised`, so a card born armed landed unarmed. Never again: one list. */
export const CARD_FIELDS = ['title', 'details', 'status', 'pos', 'blocked_reason', 'resolution', 'auto_plan', 'auto_build', 'pinned', 'archived'] as const;
export const CARD_JSON_FIELDS = ['requirements'] as const;
export type CardFields = Partial<Record<(typeof CARD_FIELDS)[number], unknown>> & { requirements?: ChecklistItem[] };

/** One checklist edit BY KEY — the way agents edit checklists: touching one
 *  item, the rest untouched. Applied in order, all-or-nothing. */
export interface ItemOp { op: 'add' | 'edit' | 'remove' | 'tick'; key?: string; text?: string; done?: boolean }

type Requirement = CardRow['requirements'][number];

export class Cards {
  constructor(private readonly db: Db, private readonly workspaces: Workspaces, private readonly events?: BoardEvents) {}

  private publish(w: WorkspaceRow, card: CardRow, extra: { from?: string; client?: string } = {}): void {
    this.events?.publish(w.id, { event: 'card', card: card as unknown as Record<string, unknown>, ...extra });
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  /** The card with this number, archived or not. */
  async byNumber(w: WorkspaceRow, number: number): Promise<CardRow | undefined> {
    const rows = await this.db.select().from(cards).where(and(eq(cards.workspace_id, w.id), eq(cards.number, number)));
    return rows[0];
  }

  /** The card a session works on — either seat, a coder or its supervisor —
   *  archived or not. Undefined when the session is on no card. */
  async ofSession(sessionId: string): Promise<CardRow | undefined> {
    const rows = await this.db.select({ card: cards }).from(sessions)
      .innerJoin(cards, eq(cards.id, sessions.cardId))
      .where(eq(sessions.id, sessionId));
    return rows[0]?.card;
  }

  /** The card with this number, only while it is on the board. */
  async activeByNumber(w: WorkspaceRow, number: number): Promise<CardRow | undefined> {
    const rows = await this.db.select().from(cards)
      .where(and(eq(cards.workspace_id, w.id), eq(cards.number, number), eq(cards.archived, false)));
    return rows[0];
  }

  /** The board: cards in column order — status, pinned first, then pos. */
  async list(w: WorkspaceRow, opts: { includeArchived?: boolean } = {}): Promise<CardRow[]> {
    return this.db.select().from(cards)
      .where(and(eq(cards.workspace_id, w.id), opts.includeArchived ? undefined : eq(cards.archived, false)))
      .orderBy(cards.status, desc(cards.pinned), cards.pos, cards.id);
  }

  /** The archive, newest change first, keyset-paged like the session list.
   *  No archived_at column exists; updated_at is the order — archiving
   *  touches it, and an archived card is rarely edited after. `total` counts
   *  the whole archive so a page knows how long the list is. */
  async listArchived(w: WorkspaceRow, page: { limit?: number; before?: string; beforeId?: number } = {}):
    Promise<{ cards: CardRow[]; total: number }> {
    const archived = and(eq(cards.workspace_id, w.id), eq(cards.archived, true));
    const older = page.before !== undefined && page.beforeId !== undefined
      ? sql`(${cards.updated_at}, ${cards.id}) < (${page.before}::timestamptz, ${page.beforeId}::bigint)` : undefined;
    let q = this.db.select().from(cards).where(and(archived, older)).orderBy(desc(cards.updated_at), desc(cards.id)).$dynamic();
    if (page.limit !== undefined) q = q.limit(page.limit);
    const [rows, [{ total }]] = await Promise.all([
      q, this.db.select({ total: sql<number>`count(*)::int` }).from(cards).where(archived)]);
    return { cards: rows, total };
  }

  /** Every card on the board in these columns — the looper's sweep. */
  async listInColumns(w: WorkspaceRow, statuses: readonly string[]): Promise<CardRow[]> {
    return this.db.select().from(cards)
      .where(and(eq(cards.workspace_id, w.id), inArray(cards.status, [...statuses]), eq(cards.archived, false)));
  }

  /** What changed on a card and when, newest first — written by a trigger,
   *  so edits made over SQL are recorded too. Empty for a card that does not
   *  exist: history goes with its card. */
  async revisions(w: WorkspaceRow, number: number, limit: number): Promise<Array<{ changed_from: unknown; changed_at: Date }>> {
    return this.db.select({ changed_from: cardRevisions.changed_from, changed_at: cardRevisions.changed_at })
      .from(cardRevisions)
      .innerJoin(cards, eq(cards.id, cardRevisions.card_id))
      .where(and(eq(cards.workspace_id, w.id), eq(cards.number, number)))
      .orderBy(desc(cardRevisions.id)).limit(limit);
  }

  /** When the card last changed column — the revision trigger's record of
   *  the newest status write. null = never moved. The looper's transition
   *  clock: entering plan is a NEW run, always. */
  async lastMovedAt(w: WorkspaceRow, number: number): Promise<Date | null> {
    const rows = await this.db.select({ at: cardRevisions.changed_at }).from(cardRevisions)
      .innerJoin(cards, eq(cards.id, cardRevisions.card_id))
      .where(and(eq(cards.workspace_id, w.id), eq(cards.number, number), sql`${cardRevisions.changed_from} ? 'status'`))
      .orderBy(desc(cardRevisions.id)).limit(1);
    return rows[0]?.at ?? null;
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /** A new card. status defaults to the first column, pos to the end of that
   *  column. The number is the workspace's next — taken under the workspace
   *  row's lock, never reused. `by` is the writer's client id, on
   *  the event. */
  async create(w: WorkspaceRow, fields: CardFields & { title: string }, by?: string): Promise<CardRow> {
    const cols = columnsOf(w);
    const status = String(fields.status ?? cols[0]);
    if (!cols.includes(status)) throw new CardError('invalid_args', `status must be one of: ${cols.join(', ')}`);
    const title = String(fields.title);
    const values: Partial<typeof cards.$inferInsert> = {};
    for (const f of CARD_FIELDS)
      if (f !== 'status' && f !== 'pos' && f !== 'title' && f in fields) values[f] = fields[f] as never;
    if ('requirements' in fields) values.requirements = keyedItems(fields.requirements as ChecklistItem[]);
    const card = await this.db.transaction(async (tx) => {
      const number = await this.workspaces.claimCardNumber(w.id, tx);
      const pos = 'pos' in fields
        ? Number(fields.pos)
        : sql`(select coalesce(max(${cards.pos}), 0) + 1 from ${cards} where ${cards.workspace_id} = ${w.id} and ${cards.status} = ${status})`;
      const [row] = await tx.insert(cards).values({ ...values, workspace_id: w.id, number, status, title, pos: pos as never }).returning();
      return row;
    });
    this.publish(w, card, { client: by });
    return card;
  }

  /** Any subset of fields; status+pos is a move. `items` changes checklist
   *  items BY KEY under the row lock, so two agents working different items
   *  both land — nothing is replaced. Returns the card and the status it had
   *  BEFORE the write (the event carries it so a listener can tell a move
   *  from an edit) and whether it was archived before (auto-push fires only
   *  on the false → true transition). */
  async update(w: WorkspaceRow, number: number, fields: CardFields, items?: ItemOp[], by?: string):
    Promise<{ card: CardRow; from: string; wasArchived: boolean }> {
    const cols = columnsOf(w);
    if ('status' in fields && !cols.includes(String(fields.status)))
      throw new CardError('invalid_args', `status must be one of: ${cols.join(', ')}`);
    for (const o of items ?? []) {
      const bad = o.op === 'add' ? (o.text === undefined ? 'add needs text' : null)
        : o.key === undefined ? `${o.op} needs key`
        : o.op === 'tick' && o.done === undefined ? 'tick needs done'
        : o.op === 'edit' && o.text === undefined && o.done === undefined ? 'edit needs text or done' : null;
      if (bad) throw new CardError('invalid_args', bad);
    }
    const set: Partial<typeof cards.$inferInsert> = {};
    for (const f of CARD_FIELDS) if (f in fields) set[f] = fields[f] as never;
    if ('requirements' in fields) {
      if (items) throw new CardError('invalid_args', 'item ops or replace requirements, not both');
      set.requirements = keyedItems(fields.requirements as ChecklistItem[]);
    }
    if (!Object.keys(set).length && !items) throw new CardError('invalid_args', 'no fields to update');

    const mine = and(eq(cards.workspace_id, w.id), eq(cards.number, number));

    // The row as it stood, read under the row lock so the transition this
    // write reports is the one it made: auto-push fires only on archived
    // false -> true (re-saving an archived card must not re-fire), and the
    // card event carries the status BEFORE the write so a listener can tell
    // a move from an edit. Item ops change named items of that same row —
    // all-or-nothing, one bad key refuses every op.
    const { card, from, wasArchived } = await this.db.transaction(async (tx) => {
      const [prior] = await tx.select({ archived: cards.archived, status: cards.status, requirements: cards.requirements })
        .from(cards).where(mine).for('update');
      if (!prior) throw new CardError('not_found', `no card ${number} in workspace ${w.id}`);
      if (items) set.requirements = applyItemOps(prior.requirements, items);
      const [row] = await tx.update(cards).set({ ...set, updated_at: new Date() }).where(mine).returning();
      return { card: row, from: prior.status, wasArchived: prior.archived };
    });
    this.publish(w, card, { from, client: by });
    return { card, from, wasArchived };
  }

  /** An archived card comes back onto the board, blocked, with the reason —
   *  what a failed auto-push on archive does. */
  async unarchiveAsBlocked(w: WorkspaceRow, number: number, reason: string): Promise<CardRow | undefined> {
    const [card] = await this.db.update(cards)
      .set({ archived: false, status: 'blocked', blocked_reason: reason, updated_at: new Date() })
      .where(and(eq(cards.workspace_id, w.id), eq(cards.number, number))).returning();
    if (card) this.publish(w, card);
    return card;
  }

  /** Hard delete — the card, its number and its history. Archive is the
   *  normal path; it keeps all three. */
  async remove(w: WorkspaceRow, number: number): Promise<boolean> {
    const [gone] = await this.db.delete(cards).where(and(eq(cards.workspace_id, w.id), eq(cards.number, number))).returning({ id: cards.id });
    if (!gone) return false;
    this.events?.publish(w.id, { event: 'deleted', id: gone.id });
    return true;
  }
}

/** The checklist after `items`, in order. Both sides key-normalized: a model
 *  echoes a key cased — that must land, not retry. A key that is not there
 *  refuses the whole batch. */
function applyItemOps(list: Requirement[], items: ItemOp[]): Requirement[] {
  const at = (o: ItemOp) => list.findIndex((e) => normalizeKey(e.key) === normalizeKey(o.key!));
  const missing = items.filter((o) => o.op !== 'add' && at(o) < 0);
  if (missing.length) {
    throw new CardError('invalid_args',
      missing.map((o) => `no "${o.key}" in requirements — the keys: ${list.map((e) => e.key).join(', ') || '(empty)'}`).join('; '));
  }
  for (const o of items) {
    if (o.op === 'add') {
      let key = newKey();
      while (list.some((e) => e.key === key)) key = newKey();
      list = [...list, { key, text: o.text!, done: o.done ?? false }];
    } else if (o.op === 'remove') {
      list = list.filter((_, i) => i !== at(o));
    } else {
      const i = at(o);
      list = list.map((e, j) => j !== i ? e
        : { ...e, ...(o.text !== undefined ? { text: o.text } : {}), ...(o.done !== undefined ? { done: o.done } : {}) });
    }
  }
  return list;
}
