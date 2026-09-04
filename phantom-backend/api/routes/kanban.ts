// Kanban, workspace-scoped: cards live in the workspace's own schema
// (workspaceSchema.ts) and are written ONLY through these routes — the API
// owns the writes. The column list and the card prefix are workspace fields
// (PATCH /workspaces/:id); defaults live here in code, the DB stores overrides.
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { workspaces, type WorkspaceRow } from '../../db/schema.js';
import { currentLoop, getSession } from '../../sessions.js';
import { logger, errStr } from '../../log.js';
import { ok, err, type AppCtx } from '../app.js';
import { resolve, resolveWithSource } from '../../settings.js';
import type { Db } from '../../db/client.js';

import { DEFAULT_COLUMNS, keyedItems, newKey, normalizeKey, type ChecklistItem } from '../../../core/kanban.js';
export { DEFAULT_COLUMNS };

/** First 3 letters of the repo name, uppercased — "phantom-looper" → "PHA". */
export function defaultPrefix(name: string): string {
  const letters = name.replace(/[^a-zA-Z]/g, '');
  return (letters || 'TSK').slice(0, 3).toUpperCase();
}

export const columnsOf = (w: WorkspaceRow): string[] =>
  (Array.isArray(w.kanbanColumns) && w.kanbanColumns.length ? w.kanbanColumns : DEFAULT_COLUMNS);
// card_prefix is a setting (workspace-scoped), so this resolves rather than
// reading a column. Unset falls through to the repo name, as it always did.
export const prefixOf = async (db: Db, w: WorkspaceRow): Promise<string> =>
  (await resolve(db, 'card_prefix', { workspace: w })) ?? defaultPrefix(w.name);

const TAG = { tags: ['kanban'] };
// THE card field list — create, update, and the schema all derive from it.
// It was three hand-kept lists once; create's copy silently lacked
// `supervised`, so a card born armed landed unarmed. Never again: one list.
const FIELDS = ['title', 'details', 'user_story', 'status', 'pos', 'blocked_reason', 'resolution', 'auto_plan', 'auto_build', 'pinned', 'archived'] as const;
const JSON_FIELDS = ['requirements'] as const;

// A whole-list write replaces the list: send it back with each item's key so
// identity survives a reword or reorder; keyless items are new and the server
// assigns their key. To change done bits use `tick` (PATCH), never a replace.
const itemSchema = { type: 'object', additionalProperties: false, required: ['text'],
  properties: { key: { type: 'string', description: 'The item\'s permanent key, from a read. Omit for new items — the server assigns one.' },
    text: { type: 'string' }, done: { type: 'boolean', default: false } } };

const cardBodyProps = {
  title: { type: 'string' },
  details: { type: 'string' },
  user_story: { type: 'string' },
  status: { type: 'string', description: 'One of the workspace\'s columns.' },
  pos: { type: 'number', description: 'Sort position within the column (fractional inserts).' },
  blocked_reason: { type: ['string', 'null'], description: 'Set to mark the card blocked; null clears it.' },
  resolution: { type: ['string', 'null'], description: 'The human\'s reply to a block — written before moving the card back; the loop clears it once the card moves on.' },
  auto_plan: { type: ['boolean', 'null'], description: 'The looper\'s per-card switch for the plan column: true/false overrides the workspace\'s auto_plan setting; null inherits it.' },
  auto_build: { type: ['boolean', 'null'], description: 'The looper\'s per-card switch for the in_progress column: true/false overrides the workspace\'s auto_build setting; null inherits it.' },
  pinned: { type: 'boolean', description: 'Pins the card to the top of its column: pinned cards sit as a group above the rest, pos still sorting inside the group.' },
  archived: { type: 'boolean' },
  requirements: { type: 'array', items: itemSchema,
    description: 'The card\'s one checklist: what must be true, each ticked done as it is VERIFIED.' },
};

const itemsSchema = { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
  required: ['op'], properties: {
    op: { enum: ['add', 'edit', 'remove', 'tick'] },
    key: { type: 'string', description: 'The item — required for edit/remove/tick.' },
    text: { type: 'string', description: 'Required for add; new text for edit.' },
    done: { type: 'boolean', description: 'Required for tick; optional initial state for add.' } } },
  description: 'Change named requirements only — add/edit/remove/tick, each touching one item; the rest ' +
    'of the list is untouched. Applied in order, all-or-nothing. Cannot be combined with replacing the list.' };

interface ItemOp { op: 'add' | 'edit' | 'remove' | 'tick'; key?: string; text?: string; done?: boolean }

// The schema must cover THE list — a field added to FIELDS without a schema
// entry would be silently stripped by validation. Checked at module load.
for (const f of [...FIELDS, ...JSON_FIELDS]) {
  if (!(f in cardBodyProps)) throw new Error(`cardBodyProps is missing '${f}' — the one field list must cover it`);
}

export interface KanbanDeps { pgPool: pg.Pool }

export function kanbanRoutes(app: FastifyInstance, ctx: AppCtx, deps: KanbanDeps) {
  const pool = deps.pgPool;
  const log = logger('kanban');
  // Every write below publishes — see boardEvents.ts. app.ts guarantees the bus.
  const events = ctx.events!;

  async function workspaceOf(id: string): Promise<WorkspaceRow | undefined> {
    const rows = await ctx.db.select().from(workspaces).where(eq(workspaces.id, id));
    return rows[0];
  }

  /** Archiving a DONE card auto-pushes its session's work, when
   *  `auto_push_on_archive` says so. Archiving a card in any other column is
   *  just archiving — it disappears from the board, nothing fires; that is the
   *  discard gesture. Detached — the PATCH answers at once; an auto-push can
   *  run for minutes. The card's session is its newest loop row's coding
   *  session; a card with no loop has nothing to push.
   *  Failure surfaces on the board: the card comes back un-archived, in
   *  blocked, with the reason. */
  async function autoPushArchivedCard(w: WorkspaceRow, seq: number): Promise<void> {
    if (!ctx.autoPush) return;
    const loop = await currentLoop(ctx.db, w.id, seq);
    const session = loop ? await getSession(ctx.db, loop.codingSessionId) : undefined;
    if (!session || session.status !== 'active') return;
    if (await resolve(ctx.db, 'auto_push_on_archive', { workspace: w, session }) !== true) return;
    // The session lock may be held (a turn mid-flight, a tool call): wait it
    // out rather than blocking the card over a moment's contention.
    let result: Awaited<ReturnType<NonNullable<typeof ctx.autoPush>>> | undefined;
    for (let i = 0; i < 30; i++) {
      try { result = await ctx.autoPush(session, w); break; }
      catch (e) {
        if ((e as { code?: string }).code === 'busy') { await new Promise((r) => setTimeout(r, 10_000)); continue; }
        result = { result: 'error', reason: e instanceof Error ? e.message : String(e) }; break;
      }
    }
    result ??= { result: 'error', reason: 'session stayed busy — auto-push never ran' };
    if (result.result === 'pushed' || result.result === 'nothing') {
      log.info({ workspace: w.name, card: seq, result: result.result }, 'auto-push on archive');
      return;
    }
    log.warn({ workspace: w.name, card: seq, result }, 'auto-push on archive failed — card un-archived into blocked');
    await pool.query(
      `update ${cardsTable(w)} set archived = false, status = 'blocked', blocked_reason = $1, updated_at = now()
       where seq = $2 returning *`,
      [`auto-push failed: ${result.reason ?? result.result}`, seq])
      .then(({ rows }) => { if (rows[0]) events.publish(w.id, { event: 'card', card: rows[0] }); })
      .catch((e) =>
        log.error({ card: seq, err: errStr(e) }, 'could not mark the card blocked after a failed auto-push'));
  }

  // The resolved looper defaults ride every board payload so the card editor
  // can always show the REAL value a card inherits — and say where it came
  // from ('override' at the store level means the global row). One pair per
  // switch: auto_plan gates the plan column, auto_build gates in_progress.
  const board = async (w: WorkspaceRow) => {
    const plan = await resolveWithSource(ctx.db, 'auto_plan', { workspace: w });
    const build = await resolveWithSource(ctx.db, 'auto_build', { workspace: w });
    const src = (s: { source: string }) => s.source === 'override' ? 'global' : s.source;
    return { prefix: await prefixOf(ctx.db, w), columns: columnsOf(w),
      workspace: w.displayName ?? w.name,
      auto_plan_default: Boolean(plan.value), auto_plan_source: src(plan),
      auto_build_default: Boolean(build.value), auto_build_source: src(build) };
  };
  const cardsTable = (w: WorkspaceRow) => `"${w.schemaName}".cards`;

  // Each card's CURRENT loop's coding session — the newest loop row per card,
  // the same ordering currentLoop() uses. Rides the board GET so the card
  // editor can name the session and open it; one query for the whole board.
  const cardSessions = async (w: WorkspaceRow) => {
    const { rows } = await pool.query(
      `select distinct on (l.card) l.card, l.coding_session_id as id, s.name
       from phantom_looper.loops l
       left join phantom_looper.sessions s on s.id = l.coding_session_id
       where l.workspace_id = $1
       order by l.card, l.created_at desc`, [w.id]);
    return rows as { card: number; id: string; name: string | null }[];
  };

  app.get<{ Params: { id: string };
    Querystring: { archived?: 'true' | 'false' | 'only'; seq?: number; limit?: number; before?: string; before_id?: number } }>(
    '/workspaces/:id/cards', { schema: { ...TAG, summary: 'The board: columns, card prefix, cards',
      description: 'Everything a board render needs in one call. Cards are ordered by column position; ' +
        'archived cards are excluded (archived=true includes them; archived=only lists JUST the archive, ' +
        'newest change first, keyset-paged like GET /sessions — limit/before/before_id, `total` = the whole archive, a short page = the ' +
        'end). seq returns the one card with that number, archived or not — the lookup for a card that is ' +
        'off the board.',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      querystring: { type: 'object', properties: {
        archived: { type: 'string', enum: ['true', 'false', 'only'], default: 'false' },
        seq: { type: 'integer', description: 'card number — return just that card, archived or not' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'archived=only: page size; omitted = everything' },
        before: { type: 'string', description: "archived=only: a row's updated_at (ISO) — return only older changes" },
        before_id: { type: 'integer', description: "that row's id, breaking updated_at ties" } } } } },
    async (req, reply) => {
      const w = await workspaceOf(req.params.id);
      if (!w) return reply.code(404).send(err('not_found', 'no such workspace'));
      if (req.query.seq !== undefined) {
        const { rows } = await pool.query(
          `select * from ${cardsTable(w)} where seq = $1`, [req.query.seq]);
        return ok({ ...await board(w), cards: rows });
      }
      if (req.query.archived === 'only') {
        // No archived_at column exists; updated_at is the order — archiving
        // touches it, and an archived card is rarely edited after.
        const values: unknown[] = [];
        let where = 'where archived';
        if (req.query.before !== undefined && req.query.before_id !== undefined) {
          values.push(req.query.before, req.query.before_id);
          where += ' and (updated_at, id) < ($1::timestamptz, $2::bigint)';
        }
        let limitSql = '';
        if (req.query.limit !== undefined) {
          values.push(req.query.limit);
          limitSql = ` limit $${values.length}`;
        }
        // `total` counts the whole archive, so a page knows how long the
        // list is — /archived's "N more" is the truth, not the rows loaded.
        const [{ rows }, { rows: [{ total }] }] = await Promise.all([
          pool.query(`select * from ${cardsTable(w)} ${where} order by updated_at desc, id desc${limitSql}`, values),
          pool.query(`select count(*)::int as total from ${cardsTable(w)} where archived`),
        ]);
        return ok({ ...await board(w), cards: rows, total });
      }
      const where = req.query.archived === 'true' ? '' : 'where not archived';
      const { rows } = await pool.query(
        `select * from ${cardsTable(w)} ${where} order by status, pinned desc, pos, id`);
      return ok({ ...await board(w), cards: rows, card_sessions: await cardSessions(w) });
    });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/workspaces/:id/cards', { schema: { ...TAG, summary: 'Create a card',
      description: 'New card. status defaults to the first column; pos defaults to the end of that column. ' +
        'The card number (seq) is assigned by the workspace\'s own sequence and never reused.',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object', additionalProperties: false, required: ['title'], properties: cardBodyProps } } },
    async (req, reply) => {
      const w = await workspaceOf(req.params.id);
      if (!w) return reply.code(404).send(err('not_found', 'no such workspace'));
      const cols = columnsOf(w);
      const status = String(req.body.status ?? cols[0]);
      if (!cols.includes(status)) return reply.code(400).send(err('invalid_args', `status must be one of: ${cols.join(', ')}`));
      const names: string[] = ['status', 'title'];
      const values: unknown[] = [status, String(req.body.title)];
      // Every card field, from THE list — status/pos/title handled above.
      for (const f of FIELDS)
        if (f !== 'status' && f !== 'pos' && f !== 'title' && f in req.body) { names.push(f); values.push(req.body[f]); }
      for (const f of JSON_FIELDS)
        if (f in req.body) { names.push(f); values.push(JSON.stringify(keyedItems(req.body[f] as ChecklistItem[]))); }
      const params = values.map((_, i) => `$${i + 1}`);
      const pos = 'pos' in req.body
        ? String(Number(req.body.pos))
        : `(select coalesce(max(pos), 0) + 1 from ${cardsTable(w)} where status = $1)`;
      const { rows } = await pool.query(
        `insert into ${cardsTable(w)} (${names.join(', ')}, pos)
         values (${params.join(', ')}, ${pos}) returning *`, values);
      // The looper runs on card writes, not on a clock: a card born straight
      // into a loop column starts here. Eligibility is the engine's to judge.
      ctx.looper?.runLoop(w.id, Number(rows[0].seq));
      events.publish(w.id, { event: 'card', card: rows[0] });
      return ok({ ...await board(w), card: rows[0] });
    });

  app.patch<{ Params: { id: string; cardId: string }; Body: Record<string, unknown> }>(
    '/workspaces/:id/cards/:cardId', { schema: { ...TAG, summary: 'Update a card',
      description: 'Any subset of fields; status+pos is a move. blocked_reason null unblocks; archived true hides ' +
        'the card from the board (archive instead of delete). items changes checklist items BY KEY ' +
        '(add/edit/remove/tick), touching nothing else — the way agents edit checklists; replacing a whole ' +
        'list is the form editor\'s path.',
      params: { type: 'object', properties: { id: { type: 'string' }, cardId: { type: 'integer' } }, required: ['id', 'cardId'] },
      body: { type: 'object', additionalProperties: false, properties: { ...cardBodyProps, items: itemsSchema } } } },
    async (req, reply) => {
      const w = await workspaceOf(req.params.id);
      if (!w) return reply.code(404).send(err('not_found', 'no such workspace'));
      const cols = columnsOf(w);
      if ('status' in req.body && !cols.includes(String(req.body.status)))
        return reply.code(400).send(err('invalid_args', `status must be one of: ${cols.join(', ')}`));
      const ops = req.body.items as ItemOp[] | undefined;
      for (const o of ops ?? []) {
        const bad = o.op === 'add' ? (o.text === undefined ? 'add needs text' : null)
          : o.key === undefined ? `${o.op} needs key`
          : o.op === 'tick' && o.done === undefined ? 'tick needs done'
          : o.op === 'edit' && o.text === undefined && o.done === undefined ? 'edit needs text or done' : null;
        if (bad) return reply.code(400).send(err('invalid_args', bad));
      }
      const sets: string[] = []; const values: unknown[] = [];
      for (const f of FIELDS)
        if (f in req.body) { values.push(req.body[f]); sets.push(`${f} = $${values.length}`); }
      if ('requirements' in req.body) {
        if (ops) return reply.code(400).send(err('invalid_args', 'item ops or replace requirements, not both'));
        values.push(JSON.stringify(keyedItems(req.body.requirements as ChecklistItem[])));
        sets.push(`requirements = $${values.length}`);
      }
      if (!sets.length && !ops) return reply.code(400).send(err('invalid_args', 'no fields to update'));

      // The auto-push trigger needs the TRANSITION, not the value: only a card
      // going false -> true archived pushes (re-saving an archived card must
      // not re-fire).
      let wasArchived: boolean | undefined;
      if (req.body.archived === true) {
        const prior = await pool.query(
          `select archived from ${cardsTable(w)} where id = $1`, [Number(req.params.cardId)]);
        wasArchived = prior.rows.length ? Boolean(prior.rows[0].archived) : undefined;
      }

      // Item ops read the list under the row lock and change named items
      // only, so two agents working different items both land — nothing is
      // replaced. All-or-nothing: one bad key refuses every op.
      const client = ops ? await pool.connect() : undefined;
      try {
        if (ops && client) {
          await client.query('begin');
          const cur = await client.query(
            `select requirements from ${cardsTable(w)} where id = $1 for update`,
            [Number(req.params.cardId)]);
          if (!cur.rows.length) { await client.query('rollback'); return reply.code(404).send(err('not_found', 'no such card')); }
          let list: { key: string; text: string; done: boolean }[] = [...cur.rows[0].requirements];
          // Both sides normalized: a model echoes a key cased — that must
          // land, not retry.
          const at = (o: ItemOp) => list.findIndex((e) => normalizeKey(e.key) === normalizeKey(o.key!));
          const missing = ops.filter((o) => o.op !== 'add' && at(o) < 0);
          if (missing.length) {
            await client.query('rollback');
            return reply.code(400).send(err('invalid_args',
              missing.map((o) => `no "${o.key}" in requirements — the keys: ${list.map((e) => e.key).join(', ') || '(empty)'}`).join('; ')));
          }
          for (const o of ops) {
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
        values.push(Number(req.params.cardId));
        const run = client ?? pool;
        const { rows } = await run.query(
          `update ${cardsTable(w)} set ${sets.join(', ')}, updated_at = now()
           where id = $${values.length} returning *`, values);
        if (client) await client.query('commit');
        if (!rows.length) return reply.code(404).send(err('not_found', 'no such card'));
        if (req.body.archived === true && wasArchived === false && rows[0].status === 'done') {
          void autoPushArchivedCard(w, Number(rows[0].seq)).catch((e) =>
            log.error({ card: rows[0].seq, err: errStr(e) }, 'auto-push on archive threw'));
        }
        // Every card write runs the looper — a move into a loop column, an
        // auto_plan/auto_build flip, an unblock. The engine re-reads the row
        // and checks canTurn itself, so an irrelevant edit is a cheap no-op.
        ctx.looper?.runLoop(w.id, Number(rows[0].seq));
        events.publish(w.id, { event: 'card', card: rows[0] });
        return ok({ ...await board(w), card: rows[0] });
      } catch (e) {
        if (client) await client.query('rollback').catch(() => {});
        throw e;
      } finally {
        client?.release();
      }
    });

  app.get<{ Params: { id: string }; Querystring: { card: number; limit: number } }>(
    '/workspaces/:id/revisions', { schema: { ...TAG, summary: "A card's revision history",
      description: 'What changed on a card and when, newest first — written by a trigger, so edits made ' +
        'over SQL are recorded too. An update holds the OLD values of the keys that changed; a delete ' +
        'holds the whole card as it last stood. card is the seq number, so deleted cards still answer.',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      querystring: { type: 'object', required: ['card'], properties: {
        card: { type: 'integer', description: 'card number — PHA-7 is card 7' },
        limit: { type: 'integer', default: 20 } } } } },
    async (req, reply) => {
      const w = await workspaceOf(req.params.id);
      if (!w) return reply.code(404).send(err('not_found', 'no such workspace'));
      const { rows } = await pool.query(
        `select op, changed, changed_at from "${w.schemaName}".card_revisions
         where seq = $1 order by id desc limit $2`, [req.query.card, req.query.limit]);
      return ok({ card: req.query.card, revisions: rows });
    });

  app.delete<{ Params: { id: string; cardId: string } }>(
    '/workspaces/:id/cards/:cardId', { schema: { ...TAG, summary: 'Delete a card permanently',
      description: 'Hard delete. Prefer PATCH archived=true — archive keeps the card and its number.',
      params: { type: 'object', properties: { id: { type: 'string' }, cardId: { type: 'integer' } }, required: ['id', 'cardId'] } } },
    async (req, reply) => {
      const w = await workspaceOf(req.params.id);
      if (!w) return reply.code(404).send(err('not_found', 'no such workspace'));
      const { rowCount } = await pool.query(
        `delete from ${cardsTable(w)} where id = $1`, [Number(req.params.cardId)]);
      if (!rowCount) return reply.code(404).send(err('not_found', 'no such card'));
      events.publish(w.id, { event: 'deleted', id: Number(req.params.cardId) });
      return ok({ deleted: true });
    });

  // The board's live feed: one long-lived ND-JSON stream per open board (the
  // cli's BoardStore holds one per workspace for as long as the app runs).
  // Records are the BoardEvents published above, plus a heartbeat so an idle
  // link stays open through proxies and the client can tell a dead one. No
  // replay: the client loads the board on connect and again on reconnect.
  app.get<{ Params: { id: string } }>(
    '/workspaces/:id/events', { schema: { ...TAG, summary: 'Board events stream',
      description: 'ND-JSON, open until the client hangs up: {event: card, card} on every create/update (the full row), ' +
        '{event: deleted, id} on a hard delete, {event: session, card, id, name} when a loop pairs a card with its ' +
        'coding session, {event: heartbeat} every 15 s. No replay — load the board on connect.',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
    async (req, reply) => {
      const w = await workspaceOf(req.params.id);
      if (!w) return reply.code(404).send(err('not_found', 'no such workspace'));
      reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const write = (o: unknown) => { reply.raw.write(`${JSON.stringify(o)}\n`); };
      const heartbeat = setInterval(() => write({ event: 'heartbeat' }), 15_000);
      const unsubscribe = events.subscribe(w.id, write);
      write({ event: 'heartbeat' });
      await new Promise<void>((resolve) => reply.raw.on('close', resolve));
      clearInterval(heartbeat);
      unsubscribe();
      return reply;
    });
}
