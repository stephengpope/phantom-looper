// Kanban, project-scoped: cards (cards.ts) are written ONLY through these
// routes — the API owns the writes. The column list and the card prefix are project fields
// (PATCH /projects/:id); defaults live here in code, the DB stores overrides.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ProjectRow } from '../../storage/schema.js';
import { columnsOf } from '../../storage/Projects.js';
import { isHeld } from '../../storage/Sessions.js';
import { CardError, CARD_FIELDS, CARD_JSON_FIELDS, type CardFields, type ItemOp } from '../../storage/Cards.js';
import { ok, err } from '../HttpApi.js';
import type { PhantomBackend } from '../../PhantomBackend.js';

const TAG = { tags: ['kanban'] };
// Cards are addressed by number everywhere a person or an agent names one
// (PHA-7 is card 7); the row id is storage's handle.
const cardNumberParam = { type: 'integer', description: 'card number — PHA-7 is card 7' };
// Who wrote: the x-phantom-looper-client header every client sends (the
// session routes' lock reads the same one). Rides each card event so a
// listener can tell the supervisor's moves from a person's.
const writerOf = (req: FastifyRequest): string | undefined => {
  const header = req.headers['x-phantom-looper-client'];
  return typeof header === 'string' && header ? header : undefined;
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
  status: { type: 'string', description: 'One of the project\'s columns.' },
  pos: { type: 'number', description: 'Sort position within the column (fractional inserts).' },
  blocked_reason: { type: ['string', 'null'], description: 'Set to mark the card blocked; null clears it.' },
  resolution: { type: ['string', 'null'], description: 'The human\'s reply to a block — written before moving the card back; the loop clears it once the card moves on.' },
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
for (const field of [...CARD_FIELDS, ...CARD_JSON_FIELDS]) {
  if (!(field in cardBodyProps)) throw new Error(`cardBodyProps is missing '${field}' — the one field list must cover it`);
}

export function kanbanRoutes(app: FastifyInstance, ctx: PhantomBackend) {
  const projectOf = (id: string) => ctx.projects.get(id);
  // The card body: the columns, the checklist, and the app's fields about a
  // card under the names it declared (Cards.fieldSchema) — accepted as if
  // they were the card's.
  const cardBody = { ...cardBodyProps, ...ctx.cards.fieldSchema };
  /** A card's own refusal, as the API's answer. */
  const cardErr = (reply: { code: (status: number) => { send: (b: unknown) => unknown } }, error: unknown) => {
    if (!(error instanceof CardError)) throw error;
    return reply.code(error.code === 'not_found' ? 404 : 400).send(err(error.code, error.message));
  };

  // Every board payload: the project's board facts, and whatever the app
  // puts beside the cards (Cards.boardExtras — its fields' defaults, say).
  const board = async (project: ProjectRow) => ({
    prefix: await ctx.projects.prefixOf(project), columns: columnsOf(project),
    project: project.displayName ?? project.name,
    ...await ctx.cards.boardExtras(project),
  });

  // Each card's owning session — the newest per card (Sessions.ownersByCard).
  // Rides the board GET so the card editor can name the session and open it.
  // `locked` is computed here (same rule as GET /sessions) so the board can
  // show a spinner on cards whose session is actively running; `workState`
  // is the stored column the 10s refresh job maintains.
  const cardSessions = async (project: ProjectRow) => {
    const now = Date.now();
    return (await ctx.sessions.ownersByCard(project.id)).map((session) => ({
      card: session.card, id: session.id, name: session.name,
      locked: isHeld(session, now),
      workState: session.workState }));
  };

  app.get<{ Params: { id: string };
    Querystring: { archived?: 'true' | 'false' | 'only'; number?: number; limit?: number; before?: string; before_id?: number } }>(
    '/projects/:id/cards', { schema: { ...TAG, summary: 'The board: columns, card prefix, cards',
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
      const project = await projectOf(req.params.id);
      if (!project) return reply.code(404).send(err('not_found', `no project ${req.params.id}`));
      if (req.query.number !== undefined) {
        const card = await ctx.cards.byNumber(project, req.query.number);
        return ok({ ...await board(project), cards: card ? [card] : [] });
      }
      if (req.query.archived === 'only') {
        const { cards, total } = await ctx.cards.listArchived(project,
          { limit: req.query.limit, before: req.query.before, beforeId: req.query.before_id });
        return ok({ ...await board(project), cards, total });
      }
      const rows = await ctx.cards.list(project, { includeArchived: req.query.archived === 'true' });
      const sessionsByCard = await cardSessions(project);
      // card_work_state: where each card's work stands against base; card_locked:
      // whether the card's coding session is held right now.
      const cardWorkState: Record<number, string | null> = {};
      const cardLocked: Record<number, boolean> = {};
      for (const cardSession of sessionsByCard) { if (cardSession.workState) cardWorkState[cardSession.card] = cardSession.workState; if (cardSession.locked) cardLocked[cardSession.card] = true; }
      return ok({ ...await board(project), cards: rows, card_sessions: sessionsByCard.map(({ workState: _workState, ...cardSession }: { workState: string | null; card: number; id: string; name: string | null; locked: boolean }) => cardSession),
        card_work_state: cardWorkState, card_locked: cardLocked });
    });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/projects/:id/cards', { schema: { ...TAG, summary: 'Create a card',
      description: 'New card. status defaults to the first column; pos defaults to the end of that column. ' +
        'The card number is the project\'s next and is never reused.',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object', additionalProperties: false, required: ['title'], properties: cardBody } } },
    async (req, reply) => {
      const project = await projectOf(req.params.id);
      if (!project) return reply.code(404).send(err('not_found', `no project ${req.params.id}`));
      // Every card write lands on the board bus (Cards.publish): the looper
      // and the archive auto-push listen there, whichever door wrote.
      let card;
      try { card = await ctx.cards.create(project, req.body as CardFields & { title: string }, writerOf(req)); }
      catch (error) { return cardErr(reply, error); }
      return ok({ ...await board(project), card });
    });

  app.patch<{ Params: { id: string; number: number }; Body: Record<string, unknown> }>(
    '/projects/:id/cards/:number', { schema: { ...TAG, summary: 'Update a card',
      description: 'Any subset of fields; status+pos is a move. blocked_reason null unblocks; archived true hides ' +
        'the card from the board (archive instead of delete). items changes checklist items BY KEY ' +
        '(add/edit/remove/tick), touching nothing else — the way agents edit checklists; replacing a whole ' +
        'list is the form editor\'s path.',
      params: { type: 'object', properties: { id: { type: 'string' }, number: cardNumberParam }, required: ['id', 'number'] },
      body: { type: 'object', additionalProperties: false, properties: { ...cardBody, items: itemsSchema } } } },
    async (req, reply) => {
      const project = await projectOf(req.params.id);
      if (!project) return reply.code(404).send(err('not_found', `no project ${req.params.id}`));
      const { items, ...fields } = req.body as CardFields & { items?: ItemOp[] };
      let card;
      try { card = (await ctx.cards.update(project, req.params.number, fields, items, writerOf(req))).card; }
      catch (error) { return cardErr(reply, error); }
      return ok({ ...await board(project), card });
    });

  app.get<{ Params: { id: string; number: number }; Querystring: { limit: number } }>(
    '/projects/:id/cards/:number/revisions', { schema: { ...TAG, summary: "A card's revision history",
      description: 'What changed on a card and when, newest first — written by a trigger, so edits made ' +
        'over SQL are recorded too. Each entry is {changed_from, changed_at}: the keys that changed and the value each had before. History ' +
        'goes with its card: a deleted card has none.',
      params: { type: 'object', properties: { id: { type: 'string' }, number: cardNumberParam }, required: ['id', 'number'] },
      querystring: { type: 'object', properties: { limit: { type: 'integer', default: 20 } } } } },
    async (req, reply) => {
      const project = await projectOf(req.params.id);
      if (!project) return reply.code(404).send(err('not_found', `no project ${req.params.id}`));
      return ok({ card: req.params.number, revisions: await ctx.cards.revisions(project, req.params.number, req.query.limit) });
    });

  app.delete<{ Params: { id: string; number: number } }>(
    '/projects/:id/cards/:number', { schema: { ...TAG, summary: 'Delete a card permanently',
      description: 'Hard delete — the card, its number and its history. Prefer PATCH archived=true, which keeps all three.',
      params: { type: 'object', properties: { id: { type: 'string' }, number: cardNumberParam }, required: ['id', 'number'] } } },
    async (req, reply) => {
      const project = await projectOf(req.params.id);
      if (!project) return reply.code(404).send(err('not_found', `no project ${req.params.id}`));
      if (!await ctx.cards.remove(project, req.params.number))
        return reply.code(404).send(err('not_found', `no card ${req.params.number} in project ${req.params.id}`));
      return ok({ deleted: true });
    });

  // The board's live feed: one long-lived ND-JSON stream per open board (the
  // cli's BoardStore holds one per project for as long as the app runs).
  // Records are the BoardEvents published above, plus a heartbeat so an idle
  // link stays open through proxies and the client can tell a dead one. No
  // replay: the client loads the board on connect and again on reconnect.
  app.get<{ Params: { id: string } }>(
    '/projects/:id/events', { schema: { ...TAG, summary: 'Board events stream',
      description: 'ND-JSON, open until the client hangs up: {event: card, card, from?, client?} on every create/update ' +
        '(the full row; from = the status before an update, client = the writer\'s x-phantom-looper-client), ' +
        '{event: deleted, id} on a hard delete, {event: session, card, id, name} when a loop pairs a card with its ' +
        'coding session, {event: heartbeat} every 15 s. No replay — load the board on connect.',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
    async (req, reply) => {
      const project = await projectOf(req.params.id);
      if (!project) return reply.code(404).send(err('not_found', `no project ${req.params.id}`));
      reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const write = (record: unknown) => { reply.raw.write(`${JSON.stringify(record)}\n`); };
      const heartbeat = setInterval(() => write({ event: 'heartbeat' }), 15_000);
      const unsubscribe = ctx.boardEvents.subscribe(project.id, write);
      write({ event: 'heartbeat' });
      await new Promise<void>((resolve) => reply.raw.on('close', resolve));
      clearInterval(heartbeat);
      unsubscribe();
      return reply;
    });
}
