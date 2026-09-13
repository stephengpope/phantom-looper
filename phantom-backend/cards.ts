// The card's one owner. Cards live in each workspace's OWN schema
// (db/workspaceSchema.ts — `"wsp_<id>".cards`), so they are addressed by the
// workspace row, and this is the only file that spells that table's name.
// Every card write publishes on the board bus with the write, so a listener
// anywhere sees it — the cli's board, the looper, Telegram — and no route has
// to remember to say so.
//
// The rules that used to live in the route live here: the column a card may
// sit in, THE field list (create, update and the API schema all derive from
// it), how checklist items are edited by key, and what a move publishes.
import type pg from 'pg';
import type { WorkspaceRow } from './db/schema.js';
import { columnsOf } from './workspaces.js';
import { keyedItems, newKey, normalizeKey, type ChecklistItem } from '../core/kanban.js';
import type { BoardEvents } from './api/boardEvents.js';

export class CardError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_args', message: string) { super(message); }
}

/** A card as the table stores it. */
export interface CardRow {
  id: number; seq: number; status: string; pos: number;
  title: string; details: string;
  requirements: { key: string; text: string; done: boolean }[];
  blocked_reason: string | null; resolution: string | null;
  auto_plan: boolean | null; auto_build: boolean | null;
  pinned: boolean; archived: boolean;
  created_at: Date; updated_at: Date;
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

export class Cards {
  constructor(private readonly pool: pg.Pool, private readonly events?: BoardEvents) {}

  /** The one place the table's name is spelled. The schema name derives from
   *  the workspace id (a ULID: [0-9a-z], injection-inert); quoting discipline
   *  is kept anyway. */
  private table(w: WorkspaceRow): string { return `"${w.schemaName}".cards`; }

  // ── reads ──────────────────────────────────────────────────────────────────

  /** The card with this number, archived or not. */
  async bySeq(w: WorkspaceRow, seq: number): Promise<CardRow | undefined> {
    const { rows } = await this.pool.query(`select * from ${this.table(w)} where seq = $1`, [seq]);
    return rows[0] as CardRow | undefined;
  }

  /** The card with this number, only while it is on the board. */
  async activeBySeq(w: WorkspaceRow, seq: number): Promise<CardRow | undefined> {
    const { rows } = await this.pool.query(
      `select * from ${this.table(w)} where seq = $1 and not archived`, [seq]);
    return rows[0] as CardRow | undefined;
  }

  /** The board: cards in column order — status, pinned first, then pos. */
  async list(w: WorkspaceRow, opts: { includeArchived?: boolean } = {}): Promise<CardRow[]> {
    const where = opts.includeArchived ? '' : 'where not archived';
    const { rows } = await this.pool.query(
      `select * from ${this.table(w)} ${where} order by status, pinned desc, pos, id`);
    return rows as CardRow[];
  }

  /** The archive, newest change first, keyset-paged like the session list.
   *  No archived_at column exists; updated_at is the order — archiving
   *  touches it, and an archived card is rarely edited after. `total` counts
   *  the whole archive so a page knows how long the list is. */
  async listArchived(w: WorkspaceRow, page: { limit?: number; before?: string; beforeId?: number } = {}):
    Promise<{ cards: CardRow[]; total: number }> {
    const values: unknown[] = [];
    let where = 'where archived';
    if (page.before !== undefined && page.beforeId !== undefined) {
      values.push(page.before, page.beforeId);
      where += ' and (updated_at, id) < ($1::timestamptz, $2::bigint)';
    }
    let limitSql = '';
    if (page.limit !== undefined) { values.push(page.limit); limitSql = ` limit $${values.length}`; }
    const [{ rows }, { rows: [{ total }] }] = await Promise.all([
      this.pool.query(`select * from ${this.table(w)} ${where} order by updated_at desc, id desc${limitSql}`, values),
      this.pool.query(`select count(*)::int as total from ${this.table(w)} where archived`),
    ]);
    return { cards: rows as CardRow[], total: Number(total) };
  }

  /** Every card on the board in these columns — the looper's sweep. */
  async listInColumns(w: WorkspaceRow, statuses: readonly string[]): Promise<CardRow[]> {
    const { rows } = await this.pool.query(
      `select * from ${this.table(w)} where status = any($1) and not archived`, [[...statuses]]);
    return rows as CardRow[];
  }

  /** Each card's column, for a batch of numbers — the session list's status icon. */
  async statusOf(w: WorkspaceRow, seqs: number[]): Promise<Map<number, string>> {
    if (!seqs.length) return new Map();
    const { rows } = await this.pool.query(
      `select seq, status from ${this.table(w)} where seq = any($1::int[])`, [seqs]);
    return new Map(rows.map((r: { seq: number; status: string }) => [r.seq, r.status]));
  }

  /** What changed on a card and when, newest first — written by a trigger,
   *  so edits made over SQL are recorded too. */
  async revisions(w: WorkspaceRow, seq: number, limit: number): Promise<Array<{ op: string; changed: unknown; changed_at: Date }>> {
    const { rows } = await this.pool.query(
      `select op, changed, changed_at from "${w.schemaName}".card_revisions where seq = $1 order by id desc limit $2`,
      [seq, limit]);
    return rows;
  }

  /** When the card last changed column — the revision trigger's record of
   *  the newest status write. null = never moved. The looper's transition
   *  clock: entering plan is a NEW loop, always. */
  async lastMovedAt(w: WorkspaceRow, seq: number): Promise<Date | null> {
    const { rows } = await this.pool.query(
      `select changed_at from "${w.schemaName}".card_revisions
       where seq = $1 and changed ? 'status' order by id desc limit 1`, [seq]);
    return rows[0]?.changed_at ?? null;
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /** A new card. status defaults to the first column, pos to the end of that
   *  column. The number (seq) comes from the workspace's own sequence and is
   *  never reused. `by` is the writer's client id, on the event. */
  async create(w: WorkspaceRow, fields: CardFields & { title: string }, by?: string): Promise<CardRow> {
    const cols = columnsOf(w);
    const status = String(fields.status ?? cols[0]);
    if (!cols.includes(status)) throw new CardError('invalid_args', `status must be one of: ${cols.join(', ')}`);
    const names: string[] = ['status', 'title'];
    const values: unknown[] = [status, String(fields.title)];
    for (const f of CARD_FIELDS)
      if (f !== 'status' && f !== 'pos' && f !== 'title' && f in fields) { names.push(f); values.push(fields[f]); }
    for (const f of CARD_JSON_FIELDS)
      if (f in fields) { names.push(f); values.push(JSON.stringify(keyedItems(fields[f] as ChecklistItem[]))); }
    const params = values.map((_, i) => `$${i + 1}`);
    const pos = 'pos' in fields
      ? String(Number(fields.pos))
      : `(select coalesce(max(pos), 0) + 1 from ${this.table(w)} where status = $1)`;
    const { rows } = await this.pool.query(
      `insert into ${this.table(w)} (${names.join(', ')}, pos) values (${params.join(', ')}, ${pos}) returning *`, values);
    const card = rows[0] as CardRow;
    this.events?.publish(w.id, { event: 'card', card: card as unknown as Record<string, unknown>, client: by });
    return card;
  }

  /** Any subset of fields; status+pos is a move. `items` changes checklist
   *  items BY KEY under the row lock, so two agents working different items
   *  both land — nothing is replaced. Returns the card and the status it had
   *  BEFORE the write (the event carries it so a listener can tell a move
   *  from an edit) and whether it was archived before (auto-push fires only
   *  on the false → true transition). */
  async update(w: WorkspaceRow, id: number, fields: CardFields, items?: ItemOp[], by?: string):
    Promise<{ card: CardRow; from: string | undefined; wasArchived: boolean | undefined }> {
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
    const sets: string[] = []; const values: unknown[] = [];
    for (const f of CARD_FIELDS)
      if (f in fields) { values.push(fields[f]); sets.push(`${f} = $${values.length}`); }
    if ('requirements' in fields) {
      if (items) throw new CardError('invalid_args', 'item ops or replace requirements, not both');
      values.push(JSON.stringify(keyedItems(fields.requirements as ChecklistItem[])));
      sets.push(`requirements = $${values.length}`);
    }
    if (!sets.length && !items) throw new CardError('invalid_args', 'no fields to update');

    // Two triggers need the TRANSITION, not the value: auto-push fires only
    // on archived false -> true (re-saving an archived card must not
    // re-fire), and the card event carries the status BEFORE the write so a
    // listener can tell a move from an edit. One read serves both.
    const prior = await this.pool.query(`select archived, status from ${this.table(w)} where id = $1`, [id]);
    const wasArchived: boolean | undefined = prior.rows.length ? Boolean(prior.rows[0].archived) : undefined;
    const from: string | undefined = prior.rows.length ? String(prior.rows[0].status) : undefined;

    // Item ops read the list under the row lock and change named items only.
    // All-or-nothing: one bad key refuses every op.
    const client = items ? await this.pool.connect() : undefined;
    try {
      if (items && client) {
        await client.query('begin');
        const cur = await client.query(`select requirements from ${this.table(w)} where id = $1 for update`, [id]);
        if (!cur.rows.length) { await client.query('rollback'); throw new CardError('not_found', `no card ${id} in workspace ${w.id}`); }
        let list: { key: string; text: string; done: boolean }[] = [...cur.rows[0].requirements];
        // Both sides normalized: a model echoes a key cased — that must land, not retry.
        const at = (o: ItemOp) => list.findIndex((e) => normalizeKey(e.key) === normalizeKey(o.key!));
        const missing = items.filter((o) => o.op !== 'add' && at(o) < 0);
        if (missing.length) {
          await client.query('rollback');
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
        values.push(JSON.stringify(list)); sets.push(`requirements = $${values.length}`);
      }
      values.push(id);
      const run = client ?? this.pool;
      const { rows } = await run.query(
        `update ${this.table(w)} set ${sets.join(', ')}, updated_at = now() where id = $${values.length} returning *`, values);
      if (client) await client.query('commit');
      if (!rows.length) throw new CardError('not_found', `no card ${id} in workspace ${w.id}`);
      const card = rows[0] as CardRow;
      this.events?.publish(w.id, { event: 'card', card: card as unknown as Record<string, unknown>, from, client: by });
      return { card, from, wasArchived };
    } catch (e) {
      if (client) await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client?.release();
    }
  }

  /** An archived card comes back onto the board, blocked, with the reason —
   *  what a failed auto-push on archive does. */
  async unarchiveAsBlocked(w: WorkspaceRow, seq: number, reason: string): Promise<CardRow | undefined> {
    const { rows } = await this.pool.query(
      `update ${this.table(w)} set archived = false, status = 'blocked', blocked_reason = $1, updated_at = now()
       where seq = $2 returning *`, [reason, seq]);
    const card = rows[0] as CardRow | undefined;
    if (card) this.events?.publish(w.id, { event: 'card', card: card as unknown as Record<string, unknown> });
    return card;
  }

  /** Hard delete. Archive is the normal path — it keeps the card and its number. */
  async remove(w: WorkspaceRow, id: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(`delete from ${this.table(w)} where id = $1`, [id]);
    if (!rowCount) return false;
    this.events?.publish(w.id, { event: 'deleted', id });
    return true;
  }
}
