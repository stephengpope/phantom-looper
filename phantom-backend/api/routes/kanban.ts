// Kanban, workspace-scoped: cards (cards.ts) are written ONLY through these
// routes — the API owns the writes. The column list and the card prefix are workspace fields
// (PATCH /workspaces/:id); defaults live here in code, the DB stores overrides.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WorkspaceRow } from '../../db/schema.js';
import { columnsOf } from '../../workspaces.js';
import { CardError, CARD_FIELDS, CARD_JSON_FIELDS, type CardFields, type ItemOp } from '../../cards.js';
import { logger, errStr } from '../../log.js';
import { ok, err, type AppCtx } from '../app.js';

const TAG = { tags: ['kanban'] };
// Cards are addressed by number everywhere a person or an agent names one
// (PHA-7 is card 7); the row id is storage's handle.
const cardNumberParam = { type: 'integer', description: 'card number — PHA-7 is card 7' };
// Who wrote: the x-phantom-looper-client header every client sends (the
// session routes' lock reads the same one). Rides each card event so a
// listener can tell the loop's moves from a person's.
const writerOf = (req: FastifyRequest): string | undefined => {
  const h = req.headers['x-phantom-looper-client'];
  return typeof h === 'string' && h ? h : undefined;
};

// A whole-list write replaces the list: send it back with each item's key so
// identity survives a reword or reorder; keyless items are new and the server
// assigns their key. To change done bits use `tick` (PATCH), never a replace.
const itemSchema = { type: 'object', additionalProperties: false, required: ['text'],
  properties: { key: { type: 'string', description: 'The item\'s permanent key, from a read. Omit for new items — the server assigns one.' },
    text: { type: 'string' }, done: { type: 'boolean', default: false } } };

const cardBodyProps = {
  title: { type: 'string' },
  details: { type: 'string' },
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

// The schema must cover THE list (cards.ts) — a field added there without a
// schema entry would be silently stripped by validation. Checked at load.
for (const f of [...CARD_FIELDS, ...CARD_JSON_FIELDS]) {
  if (!(f in cardBodyProps)) throw new Error(`cardBodyProps is missing '${f}' — the one field list must cover it`);
}

export function kanbanRoutes(app: FastifyInstance, ctx: AppCtx) {
  const log = logger('kanban');
  const workspaceOf = (id: string) => ctx.workspaces.get(id);
  /** A card's own refusal, as the API's answer. */
  const cardErr = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) => {
    if (!(e instanceof CardError)) throw e;
    return reply.code(e.code === 'not_found' ? 404 : 400).send(err(e.code, e.message));
  };

  /** Archiving a DONE card auto-pushes its session's work, when
   *  `auto_push_on_archive` says so. Archiving a card in any other column is
   *  just archiving — it disappears from the board, nothing fires; that is the
   *  discard gesture. Detached — the PATCH answers at once; an auto-push can
   *  run for minutes. The card's session is its newest coding session; a
   *  card with none has nothing to push.
   *  Failure surfaces on the board: the card comes back un-archived, in
   *  blocked, with the reason. */
  async function autoPushArchivedCard(w: WorkspaceRow, number: number): Promise<void> {
    if (!ctx.autoPush) return;
    const session = await ctx.sessions.coderOf(w.id, number);
    if (!session || session.status !== 'active') return;
    if (await ctx.settings.resolve('auto_push_on_archive', { workspace: w, session }) !== true) return;
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
      log.info({ workspace: w.name, card: number, result: result.result }, 'auto-push on archive');
      return;
    }
    log.warn({ workspace: w.name, card: number, result }, 'auto-push on archive failed — card un-archived into blocked');
    await ctx.cards.unarchiveAsBlocked(w, number, `auto-push failed: ${result.reason ?? result.result}`)
      .catch((e) =>
        log.error({ card: number, err: errStr(e) }, 'could not mark the card blocked after a failed auto-push'));
  }

  // The resolved looper defaults ride every board payload so the card editor
  // can always show the REAL value a card inherits — and say where it came
  // from ('override' at the store level means the global row). One pair per
  // switch: auto_plan gates the plan column, auto_build gates in_progress.
  const board = async (w: WorkspaceRow) => {
    const plan = await ctx.settings.resolveWithSource('auto_plan', { workspace: w });
    const build = await ctx.settings.resolveWithSource('auto_build', { workspace: w });
    const src = (s: { source: string }) => s.source === 'override' ? 'global' : s.source;
    return { prefix: await ctx.workspaces.prefixOf(w), columns: columnsOf(w),
      workspace: w.displayName ?? w.name,
      auto_plan_default: Boolean(plan.value), auto_plan_source: src(plan),
      auto_build_default: Boolean(build.value), auto_build_source: src(build) };
  };

  // Each card's coding session — the newest per card (Sessions.codersByCard).
  // Rides the board GET so the card editor can name the session and open it.
  // `locked` is computed here (same rule as GET /sessions) so the board can
  // show a spinner on cards whose session is actively running; `work` is
  // the stored column the 10s refresh job maintains.
  const cardSessions = async (w: WorkspaceRow) => {
    const now = Date.now();
    return (await ctx.sessions.codersByCard(w.id)).map((s) => ({
      card: s.card, id: s.id, name: s.name,
      locked: !!s.lockedBy && !!s.lockExpiresAt && s.lockExpiresAt.getTime() > now,
      work: s.work }));
  };

  app.get<{ Params: { id: string };
    Querystring: { archived?: 'true' | 'false' | 'only'; number?: number; limit?: number; before?: string; before_id?: number } }>(
    '/workspaces/:id/cards', { schema: { ...TAG, summary: 'The board: columns, card prefix, cards',
      description: 'Everything a board render needs in one call. Cards are ordered by column position; ' +
        'archived cards are excluded (archived=true includes them; archived=only lists JUST the archive, ' +
        'newest change first, keyset-paged like GET /sessions — limit/before/before_id, `total` = the whole archive, a short page = the ' +
        'end). number returns the one card with that number, archived or not — the lookup for a card that is ' +
        'off the board.',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      querystring: { type: 'object', properties: {
        archived: { type: 'string', enum: ['true', 'false', 'only'], default: 'false' },
        number: { type: 'integer', description: 'card number — return just that card, archived or not' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'archived=only: page size; omitted = everything' },
        before: { type: 'string', description: "archived=only: a row's updated_at (ISO) — return only older changes" },
        before_id: { type: 'integer', description: "that row's id, breaking updated_at ties" } } } } },
    async (req, reply) => {
      const w = await workspaceOf(req.params.id);
      if (!w) return reply.code(404).send(err('not_found', `no workspace ${req.params.id}`));
      if (req.query.number !== undefined) {
        const card = await ctx.cards.byNumber(w, req.query.number);
        return ok({ ...await board(w), cards: card ? [card] : [] });
      }
      if (req.query.archived === 'only') {
        const { cards, total } = await ctx.cards.listArchived(w,
          { limit: req.query.limit, before: req.query.before, beforeId: req.query.before_id });
        return ok({ ...await board(w), cards, total });
      }
      const rows = await ctx.cards.list(w, { includeArchived: req.query.archived === 'true' });
      const cs = await cardSessions(w);
      // card_work: the git work state per card; card_locked: whether the
      // card's coding session is held right now.
      const cardWork: Record<number, string | null> = {};
      const cardLocked: Record<number, boolean> = {};
      for (const c of cs) { if (c.work) cardWork[c.card] = c.work; if (c.locked) cardLocked[c.card] = true; }
      return ok({ ...await board(w), cards: rows, card_sessions: cs.map(({ work: _w, ...c }) => c),
        card_work: cardWork, card_locked: cardLocked });
    });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/workspaces/:id/cards', { schema: { ...TAG, summary: 'Create a card',
      description: 'New card. status defaults to the first column; pos defaults to the end of that column. ' +
        'The card number is the workspace\'s next and is never reused.',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object', additionalProperties: false, required: ['title'], properties: cardBodyProps } } },
    async (req, reply) => {
      const w = await workspaceOf(req.params.id);
      if (!w) return reply.code(404).send(err('not_found', `no workspace ${req.params.id}`));
      let card;
      try { card = await ctx.cards.create(w, req.body as CardFields & { title: string }, writerOf(req)); }
      catch (e) { return cardErr(reply, e); }
      // The looper runs on card writes, not on a clock: a card born straight
      // into a loop column starts here. Eligibility is the engine's to judge.
      ctx.looper?.runLoop(w.id, card.number);
      return ok({ ...await board(w), card });
    });

  app.patch<{ Params: { id: string; number: number }; Body: Record<string, unknown> }>(
    '/workspaces/:id/cards/:number', { schema: { ...TAG, summary: 'Update a card',
      description: 'Any subset of fields; status+pos is a move. blocked_reason null unblocks; archived true hides ' +
        'the card from the board (archive instead of delete). items changes checklist items BY KEY ' +
        '(add/edit/remove/tick), touching nothing else — the way agents edit checklists; replacing a whole ' +
        'list is the form editor\'s path.',
      params: { type: 'object', properties: { id: { type: 'string' }, number: cardNumberParam }, required: ['id', 'number'] },
      body: { type: 'object', additionalProperties: false, properties: { ...cardBodyProps, items: itemsSchema } } } },
    async (req, reply) => {
      const w = await workspaceOf(req.params.id);
      if (!w) return reply.code(404).send(err('not_found', `no workspace ${req.params.id}`));
      const { items, ...fields } = req.body as CardFields & { items?: ItemOp[] };
      let written;
      try { written = await ctx.cards.update(w, req.params.number, fields, items, writerOf(req)); }
      catch (e) { return cardErr(reply, e); }
      const { card, wasArchived } = written;
      if (req.body.archived === true && wasArchived === false && card.status === 'done') {
        void autoPushArchivedCard(w, card.number).catch((e) =>
          log.error({ card: card.number, err: errStr(e) }, 'auto-push on archive threw'));
      }
      // Every card write runs the looper — a move into a loop column, an
      // auto_plan/auto_build flip, an unblock. The engine re-reads the row
      // and checks canTurn itself, so an irrelevant edit is a cheap no-op.
      ctx.looper?.runLoop(w.id, card.number);
      return ok({ ...await board(w), card });
    });

  app.get<{ Params: { id: string; number: number }; Querystring: { limit: number } }>(
    '/workspaces/:id/cards/:number/revisions', { schema: { ...TAG, summary: "A card's revision history",
      description: 'What changed on a card and when, newest first — written by a trigger, so edits made ' +
        'over SQL are recorded too. Each entry is {changed_from, changed_at}: the keys that changed and the value each had before. History ' +
        'goes with its card: a deleted card has none.',
      params: { type: 'object', properties: { id: { type: 'string' }, number: cardNumberParam }, required: ['id', 'number'] },
      querystring: { type: 'object', properties: { limit: { type: 'integer', default: 20 } } } } },
    async (req, reply) => {
      const w = await workspaceOf(req.params.id);
      if (!w) return reply.code(404).send(err('not_found', `no workspace ${req.params.id}`));
      return ok({ card: req.params.number, revisions: await ctx.cards.revisions(w, req.params.number, req.query.limit) });
    });

  app.delete<{ Params: { id: string; number: number } }>(
    '/workspaces/:id/cards/:number', { schema: { ...TAG, summary: 'Delete a card permanently',
      description: 'Hard delete — the card, its number and its history. Prefer PATCH archived=true, which keeps all three.',
      params: { type: 'object', properties: { id: { type: 'string' }, number: cardNumberParam }, required: ['id', 'number'] } } },
    async (req, reply) => {
      const w = await workspaceOf(req.params.id);
      if (!w) return reply.code(404).send(err('not_found', `no workspace ${req.params.id}`));
      if (!await ctx.cards.remove(w, req.params.number))
        return reply.code(404).send(err('not_found', `no card ${req.params.number} in workspace ${req.params.id}`));
      return ok({ deleted: true });
    });

  // The board's live feed: one long-lived ND-JSON stream per open board (the
  // cli's BoardStore holds one per workspace for as long as the app runs).
  // Records are the BoardEvents published above, plus a heartbeat so an idle
  // link stays open through proxies and the client can tell a dead one. No
  // replay: the client loads the board on connect and again on reconnect.
  app.get<{ Params: { id: string } }>(
    '/workspaces/:id/events', { schema: { ...TAG, summary: 'Board events stream',
      description: 'ND-JSON, open until the client hangs up: {event: card, card, from?, client?} on every create/update ' +
        '(the full row; from = the status before an update, client = the writer\'s x-phantom-looper-client), ' +
        '{event: deleted, id} on a hard delete, {event: session, card, id, name} when a loop pairs a card with its ' +
        'coding session, {event: heartbeat} every 15 s. No replay — load the board on connect.',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
    async (req, reply) => {
      const w = await workspaceOf(req.params.id);
      if (!w) return reply.code(404).send(err('not_found', `no workspace ${req.params.id}`));
      reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const write = (o: unknown) => { reply.raw.write(`${JSON.stringify(o)}\n`); };
      const heartbeat = setInterval(() => write({ event: 'heartbeat' }), 15_000);
      const unsubscribe = ctx.events!.subscribe(w.id, write);
      write({ event: 'heartbeat' });
      await new Promise<void>((resolve) => reply.raw.on('close', resolve));
      clearInterval(heartbeat);
      unsubscribe();
      return reply;
    });
}
