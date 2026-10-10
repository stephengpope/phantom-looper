// The card's one owner. Cards live in ONE table (phantom_agent_sdk.cards, 024),
// addressed by project id; this is the only file that queries it. Every
// card write publishes on the board bus with the write, so a listener
// anywhere sees it — the cli's board, the looper, Telegram — and no route has
// to remember to say so.
//
// The rules that used to live in the route live here: the column a card may
// sit in, THE field list (create, update and the API schema all derive from
// it), how checklist items are edited by key, and what a move publishes.
//
// An app's fields ABOUT a card (CardFieldsExtension) ride every card this
// object answers and are taken by every write it makes — read in one place
// (#withFields), written in one place (#writeFields), their history recorded
// here. Nothing outside this file knows they are not columns.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Drizzle, Transaction } from './Database.js';
import { textOf } from '../lib/text.js';
// `sessions` is here for ONE read: the card a session works on is a join on
// sessions.card_id. Read through the join only; the row is Sessions' to write.
import { cards, cardRevisions, sessions, type CardRow, type ProjectRow } from '../storage/schema.js';
import { columnsOf, type Projects } from './Projects.js';
import { keyedItems, newKey, normalizeKey, type ChecklistItem } from '@phantom-agent-sdk/client';
import type { BoardEvents } from '../agents/BoardEvents.js';
import type { CardFieldsExtension } from '../doors.js';

export type { CardRow };
/** A card as this object answers it: the row, plus the app's fields about
 *  it under the names the app declared (null where the app has none set). */
export type Card = CardRow & Record<string, unknown>;

export class CardError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_args', message: string) { super(message); }
}

/** THE card field list — create, update, and the API schema all derive from
 *  it. It was three hand-kept lists once; create's copy silently lacked
 *  `supervised`, so a card born armed landed unarmed. Never again: one list. */
export const CARD_FIELDS = ['title', 'details', 'status', 'pos', 'blocked_reason', 'resolution', 'pinned', 'archived'] as const;
export const CARD_JSON_FIELDS = ['requirements'] as const;
/** What a write may carry: the columns, the checklist, and the app's fields by their names. */
export type CardFields = Partial<Record<(typeof CARD_FIELDS)[number], unknown>> & { requirements?: ChecklistItem[] } & Record<string, unknown>;

/** One checklist edit BY KEY — the way agents edit checklists: touching one
 *  item, the rest untouched. Applied in order, all-or-nothing. */
export interface ItemOp { op: 'add' | 'edit' | 'remove' | 'tick'; key?: string; text?: string; done?: boolean }

type Requirement = CardRow['requirements'][number];

export class Cards {
  constructor(private readonly database: Drizzle, private readonly projects: Projects, private readonly events?: BoardEvents,
    private readonly extension?: CardFieldsExtension) {}

  /** The app's field names — what a write may carry beside the columns. */
  private get fieldNames(): string[] { return Object.keys(this.extension?.schema ?? {}); }

  /** The JSON Schema of the app's fields, for the API's card body. */
  get fieldSchema(): Record<string, Record<string, unknown>> { return { ...this.extension?.schema }; }

  /** What the app puts on the board payload beside the cards. */
  async boardExtras(project: ProjectRow): Promise<Record<string, unknown>> {
    return this.extension?.board ? this.extension.board(project) : {};
  }

  /** Rows as cards: the app's fields glued on, one read for the lot; a
   *  declared field the app has nothing for is null. */
  async #withFields(rows: CardRow[]): Promise<Card[]> {
    const names = this.fieldNames;
    if (!names.length || !rows.length) return rows;
    const fields = await this.extension!.read(rows.map((row) => row.id));
    return rows.map((row) => ({ ...Object.fromEntries(names.map((name) => [name, null])), ...fields.get(row.id), ...row }));
  }
  async #oneWithFields(row: CardRow | undefined): Promise<Card | undefined> {
    return row && (await this.#withFields([row]))[0];
  }

  /** Split a write into the columns' part and the app's. A name that is
   *  neither is refused — the API schema already does, the tools' and the
   *  app's own callers come through here too. */
  private split(fields: CardFields): { columns: Partial<typeof cards.$inferInsert>; app: Record<string, unknown> } {
    const columns: Partial<typeof cards.$inferInsert> = {};
    const app: Record<string, unknown> = {};
    const names = this.fieldNames;
    for (const [key, value] of Object.entries(fields)) {
      if ((CARD_FIELDS as readonly string[]).includes(key)) columns[key as (typeof CARD_FIELDS)[number]] = value as never;
      else if (key === 'requirements') continue;
      else if (names.includes(key)) app[key] = value;
      else throw new CardError('invalid_args', `no card field "${key}"`);
    }
    return { columns, app };
  }

  /** The app's part of a write, inside the SDK's transaction; the values
   *  before come back for the history. */
  async #writeFields(cardId: number, app: Record<string, unknown>, transaction: Transaction): Promise<Record<string, unknown>> {
    if (!Object.keys(app).length) return {};
    return this.extension!.write(cardId, app, transaction);
  }

  private publish(project: ProjectRow, card: Card, extra: { from?: string; client?: string; archivedBefore?: boolean } = {}): void {
    this.events?.publish(project.id, { event: 'card', card: card as unknown as Record<string, unknown>, ...extra });
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  /** The card with this number, archived or not. */
  async byNumber(project: ProjectRow, number: number): Promise<Card | undefined> {
    const rows = await this.database.select().from(cards).where(and(eq(cards.project_id, project.id), eq(cards.number, number)));
    return this.#oneWithFields(rows[0]);
  }

  /** The card a session works on — either seat, a coder or its supervisor —
   *  archived or not. Undefined when the session is on no card. */
  async ofSession(sessionId: string): Promise<Card | undefined> {
    const rows = await this.database.select({ card: cards }).from(sessions)
      .innerJoin(cards, eq(cards.id, sessions.cardId))
      .where(eq(sessions.id, sessionId));
    return this.#oneWithFields(rows[0]?.card);
  }

  /** The card with this number, only while it is on the board. */
  async activeByNumber(project: ProjectRow, number: number): Promise<Card | undefined> {
    const rows = await this.database.select().from(cards)
      .where(and(eq(cards.project_id, project.id), eq(cards.number, number), eq(cards.archived, false)));
    return this.#oneWithFields(rows[0]);
  }

  /** The board: cards in column order — status, pinned first, then pos. */
  async list(project: ProjectRow, opts: { includeArchived?: boolean } = {}): Promise<Card[]> {
    return this.#withFields(await this.database.select().from(cards)
      .where(and(eq(cards.project_id, project.id), opts.includeArchived ? undefined : eq(cards.archived, false)))
      .orderBy(cards.status, desc(cards.pinned), cards.pos, cards.id));
  }

  /** The archive, newest change first, keyset-paged like the session list.
   *  No archived_at column exists; updated_at is the order — archiving
   *  touches it, and an archived card is rarely edited after. `total` counts
   *  the whole archive so a page knows how long the list is. */
  async listArchived(project: ProjectRow, page: { limit?: number; before?: string; beforeId?: number } = {}):
    Promise<{ cards: Card[]; total: number }> {
    const archived = and(eq(cards.project_id, project.id), eq(cards.archived, true));
    const older = page.before !== undefined && page.beforeId !== undefined
      ? sql`(${cards.updated_at}, ${cards.id}) < (${page.before}::timestamptz, ${page.beforeId}::bigint)` : undefined;
    let query = this.database.select().from(cards).where(and(archived, older)).orderBy(desc(cards.updated_at), desc(cards.id)).$dynamic();
    if (page.limit !== undefined) query = query.limit(page.limit);
    const [rows, totals] = await Promise.all([
      query, this.database.select({ total: sql<number>`count(*)::int` }).from(cards).where(archived)]);
    const total = totals[0].total;
    return { cards: await this.#withFields(rows), total };
  }

  /** Every card on the board in these columns — the looper's sweep for cards to start. */
  async listInColumns(project: ProjectRow, statuses: readonly string[]): Promise<Card[]> {
    return this.#withFields(await this.database.select().from(cards)
      .where(and(eq(cards.project_id, project.id), inArray(cards.status, [...statuses]), eq(cards.archived, false))));
  }

  /** What changed on a card and when, newest first — written by a trigger,
   *  so edits made over SQL are recorded too. Empty for a card that does not
   *  exist: history goes with its card. */
  async revisions(project: ProjectRow, number: number, limit: number): Promise<Array<{ changed_from: unknown; changed_at: Date }>> {
    return this.database.select({ changed_from: cardRevisions.changed_from, changed_at: cardRevisions.changed_at })
      .from(cardRevisions)
      .innerJoin(cards, eq(cards.id, cardRevisions.card_id))
      .where(and(eq(cards.project_id, project.id), eq(cards.number, number)))
      .orderBy(desc(cardRevisions.id)).limit(limit);
  }

  /** When the card last changed column — the revision trigger's record of
   *  the newest status write. null = never moved. The looper's transition
   *  clock: entering plan is a NEW run, always. */
  async lastMovedAt(project: ProjectRow, number: number): Promise<Date | null> {
    const rows = await this.database.select({ at: cardRevisions.changed_at }).from(cardRevisions)
      .innerJoin(cards, eq(cards.id, cardRevisions.card_id))
      .where(and(eq(cards.project_id, project.id), eq(cards.number, number), sql`${cardRevisions.changed_from} ? 'status'`))
      .orderBy(desc(cardRevisions.id)).limit(1);
    return rows[0]?.at ?? null;
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /** A new card. status defaults to the first column, pos to the end of that
   *  column. The number is the project's next — taken under the project
   *  row's lock, never reused. `by` is the writer's client id, on
   *  the event. */
  async create(project: ProjectRow, fields: CardFields & { title: string }, by?: string): Promise<Card> {
    const cols = columnsOf(project);
    const status = textOf(fields.status ?? cols[0]);
    if (!cols.includes(status)) throw new CardError('invalid_args', `status must be one of: ${cols.join(', ')}`);
    const title = String(fields.title);
    const { columns, app } = this.split(fields);
    const { status: _status, pos: _pos, title: _title, ...values } = columns;
    if ('requirements' in fields) values.requirements = keyedItems(fields.requirements as ChecklistItem[]);
    const row = await this.database.transaction(async (transaction) => {
      const number = await this.projects.claimCardNumber(project.id, transaction);
      const pos = 'pos' in fields
        ? Number(fields.pos)
        : sql`(select coalesce(max(${cards.pos}), 0) + 1 from ${cards} where ${cards.project_id} = ${project.id} and ${cards.status} = ${status})`;
      const [inserted] = await transaction.insert(cards).values({ ...values, project_id: project.id, number, status, title, pos: pos as never }).returning();
      await this.#writeFields(inserted.id, app, transaction);
      return inserted;
    });
    const card = (await this.#oneWithFields(row))!;
    this.publish(project, card, { client: by });
    return card;
  }

  /** Any subset of fields; status+pos is a move. `items` changes checklist
   *  items BY KEY under the row lock, so two agents working different items
   *  both land — nothing is replaced. Returns the card and the status it had
   *  BEFORE the write (the event carries it so a listener can tell a move
   *  from an edit) and whether it was archived before (auto-push fires only
   *  on the false → true transition). */
  async update(project: ProjectRow, number: number, fields: CardFields, items?: ItemOp[], by?: string):
    Promise<{ card: Card; from: string; wasArchived: boolean }> {
    const cols = columnsOf(project);
    if ('status' in fields && !cols.includes(String(fields.status)))
      throw new CardError('invalid_args', `status must be one of: ${cols.join(', ')}`);
    for (const operation of items ?? []) {
      const bad = operation.op === 'add' ? (operation.text === undefined ? 'add needs text' : null)
        : operation.key === undefined ? `${operation.op} needs key`
        : operation.op === 'tick' && operation.done === undefined ? 'tick needs done'
        : operation.op === 'edit' && operation.text === undefined && operation.done === undefined ? 'edit needs text or done' : null;
      if (bad) throw new CardError('invalid_args', bad);
    }
    const { columns: set, app } = this.split(fields);
    if ('requirements' in fields) {
      if (items) throw new CardError('invalid_args', 'item ops or replace requirements, not both');
      set.requirements = keyedItems(fields.requirements as ChecklistItem[]);
    }
    if (!Object.keys(set).length && !Object.keys(app).length && !items) throw new CardError('invalid_args', 'no fields to update');

    const mine = and(eq(cards.project_id, project.id), eq(cards.number, number));

    // The row as it stood, read under the row lock so the transition this
    // write reports is the one it made: auto-push fires only on archived
    // false -> true (re-saving an archived card must not re-fire), and the
    // card event carries the status BEFORE the write so a listener can tell
    // a move from an edit. Item ops change named items of that same row —
    // all-or-nothing, one bad key refuses every op.
    // The app's fields change in the same transaction; what they were
    // before is the card's history too, written here — the trigger that
    // records the columns never sees the app's table.
    const { row, from, wasArchived } = await this.database.transaction(async (transaction) => {
      const [prior] = await transaction.select({ archived: cards.archived, status: cards.status, requirements: cards.requirements })
        .from(cards).where(mine).for('update');
      if (!prior) throw new CardError('not_found', `no card ${number} in project ${project.id}`);
      if (items) set.requirements = applyItemOps(prior.requirements, items);
      const [updated] = await transaction.update(cards).set({ ...set, updated_at: new Date() }).where(mine).returning();
      const before = await this.#writeFields(updated.id, app, transaction);
      if (Object.keys(before).length) await transaction.insert(cardRevisions).values({ card_id: updated.id, changed_from: before });
      return { row: updated, from: prior.status, wasArchived: prior.archived };
    });
    const card = (await this.#oneWithFields(row))!;
    this.publish(project, card, { from, client: by, archivedBefore: wasArchived });
    return { card, from, wasArchived };
  }

  /** An archived card comes back onto the board, blocked, with the reason —
   *  what a failed auto-push on archive does. */
  async unarchiveAsBlocked(project: ProjectRow, number: number, reason: string): Promise<Card | undefined> {
    const [row] = await this.database.update(cards)
      .set({ archived: false, status: 'blocked', blocked_reason: reason, updated_at: new Date() })
      .where(and(eq(cards.project_id, project.id), eq(cards.number, number))).returning();
    const card = await this.#oneWithFields(row);
    if (card) this.publish(project, card);
    return card;
  }

  /** Hard delete — the card, its number and its history. Archive is the
   *  normal path; it keeps all three. */
  async remove(project: ProjectRow, number: number): Promise<boolean> {
    const [gone] = await this.database.delete(cards).where(and(eq(cards.project_id, project.id), eq(cards.number, number))).returning({ id: cards.id });
    if (!gone) return false;
    this.events?.publish(project.id, { event: 'deleted', id: gone.id });
    return true;
  }
}

/** The checklist after `items`, in order. Both sides key-normalized: a model
 *  echoes a key cased — that must land, not retry. A key that is not there
 *  refuses the whole batch. */
function applyItemOps(list: Requirement[], items: ItemOp[]): Requirement[] {
  const at = (operation: ItemOp) => list.findIndex((item) => normalizeKey(item.key) === normalizeKey(operation.key!));
  const missing = items.filter((operation) => operation.op !== 'add' && at(operation) < 0);
  if (missing.length) {
    throw new CardError('invalid_args',
      missing.map((operation) => `no "${operation.key}" in requirements — the keys: ${list.map((item) => item.key).join(', ') || '(empty)'}`).join('; '));
  }
  for (const operation of items) {
    if (operation.op === 'add') {
      let key = newKey();
      while (list.some((item) => item.key === key)) key = newKey();
      list = [...list, { key, text: operation.text!, done: operation.done ?? false }];
    } else if (operation.op === 'remove') {
      list = list.filter((_, i) => i !== at(operation));
    } else {
      const i = at(operation);
      list = list.map((item, j) => j !== i ? item
        : { ...item, ...(operation.text !== undefined ? { text: operation.text } : {}), ...(operation.done !== undefined ? { done: operation.done } : {}) });
    }
  }
  return list;
}
