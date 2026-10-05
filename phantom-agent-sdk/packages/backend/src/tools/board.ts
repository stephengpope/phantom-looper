// The BOARD tools — the project's cards, over Cards (cards.ts), the one
// owner of card rows. The coding agent and the supervisor read cards; the
// assistant runs the whole board. A card run's card-bound powers
// (kanban_card_move / kanban_card_items / kanban_card_block bound to THE
// card) are the coding agent's and the supervisor's own tools for that run, added by the run — not here.
import { CardError, type CardFields, type ItemOp } from '../storage/Cards.js';
import type { CardRow } from '../storage/schema.js';
import { columnsOf } from '../storage/Projects.js';
import { int, nullable, obj, oneOf, refusal, str, type ToolCtx, type ToolDef } from './def.js';

const cardNo = int('card number — PHA-7 is card 7');

/** The same read shape whichever agent reads it. */
const renderCard = (card: CardRow) => ({ card: card.number, title: card.title, status: card.status, details: card.details,
  requirements: card.requirements, blocked_reason: card.blocked_reason, archived: card.archived });

/** A card's own refusal, as the tool's answer — written for the agent. */
async function cardCall<T>(body: () => Promise<T>): Promise<T> {
  try { return await body(); }
  catch (error) {
    if (error instanceof CardError) throw refusal(error.code, error.message);
    throw error;
  }
}

const patch = (ctx: ToolCtx, number: number, fields: CardFields, items?: ItemOp[]) =>
  cardCall(async () => renderCard((await ctx.app.cards.update(ctx.project, number, fields, items, ctx.client)).card));

const itemsSchema = {
  type: 'array', minItems: 1,
  items: obj({
    op: oneOf(['add', 'edit', 'remove', 'tick'], 'what to do to the item'),
    key: str('the item — required for edit/remove/tick'),
    text: str('required for add; new wording for edit'),
    done: { type: 'boolean', description: 'required for tick; optional starting state for add' },
  }, ['op']),
};

const ITEMS_DESCRIPTION = 'add, edit (reword), remove, tick — each op touches ONE item, ' +
  'named by its key; the rest of the list cannot be touched. Keys come back from kanban_card_read and every ' +
  'write result — copy them from there, never invent one. add needs only text (the server assigns the key, ' +
  'returned in the result). Ops apply in order, all-or-nothing. THE way to change the list — there is no ' +
  'whole-list send. Tick done true means you VERIFIED it, not that you wrote code for it.';

/** The card's column, as the board has it: the project's own columns are
 *  in the description, since a listing is built per session and the schema
 *  itself stays static. */
const statusField = (description: string) => str(`${description} — one of the project's columns (kanban_card_list names them)`);


export const BOARD_TOOLS: ToolDef[] = [
  {
    name: 'kanban_card_read',
    summary: 'One whole card.',
    description: 'One whole card — details and the requirements list, each item with its key ' +
      '(the handle kanban_card_items takes). Read it before planning, and RE-read it when retrying or resuming — ' +
      'the card is the source of truth, not your memory of it. Cards are numbered: PHA-7 is card 7. ' +
      'Use the board only when the user points you at a card; a task needs no card.',
    input: obj({ card: cardNo }, ['card']),
    mutates: false, group: 'board',
    async execute(ctx, a) {
      const card = await ctx.app.cards.byNumber(ctx.project, Number(a.card));
      if (!card) throw refusal('not_found', `no card ${String(a.card)} — pass the card number`);
      return renderCard(card);
    },
  },
  {
    name: 'kanban_card_list',
    summary: 'Every column and card.',
    description: 'Every column and card (number, title, status) — a card is what people also call an issue, ' +
      'task, todo, or ticket. Cards are numbered — PHA-7 is card 7. ' +
      'Call before referring to cards by number; numbers come from here, never invented.',
    input: obj({}),
    mutates: false, group: 'board',
    async execute(ctx) {
      const cards = await ctx.app.cards.list(ctx.project);
      return { prefix: await ctx.app.projects.prefixOf(ctx.project), columns: columnsOf(ctx.project),
        cards: cards.map((card) => ({ card: card.number, title: card.title, status: card.status })) };
    },
  },
  {
    name: 'kanban_card_create',
    summary: 'Create a card.',
    description: 'Creates a card on the board (task, issue, bug, ticket, or todo).',
    input: obj({
      title: str('the card title'),
      details: str('what the card is about'),
      status: statusField('the column'),
      blocked_reason: nullable('string', 'set to mark the card blocked'),
      requirements: { type: 'array', description: 'what must be true for the card to be done — done means VERIFIED, not written',
        items: obj({ text: str('the requirement'), done: { type: 'boolean' } }, ['text']) },
    }, ['title']),
    mutates: true, group: 'board',
    execute: (ctx, a) => cardCall(async () =>
      renderCard(await ctx.app.cards.create(ctx.project, a as CardFields & { title: string }, ctx.client))),
  },
  {
    name: 'kanban_card_update',
    summary: "Change a card's fields.",
    description: 'Change the card\'s FIELDS: title, details, column, blocked_reason (blocked means status ' +
      '"blocked"), archived true takes it off the board. Requirements are not fields — change those with kanban_card_items.',
    input: obj({
      card: cardNo, title: str('new title'), details: str('new details'), status: statusField('the column'),
      blocked_reason: nullable('string', 'set to mark the card blocked; null clears it'),
      archived: { type: 'boolean', description: 'true takes the card off the board' },
    }, ['card']),
    mutates: true, group: 'board',
    execute: (ctx, { card, ...rest }) => patch(ctx, Number(card), rest),
  },
  {
    name: 'kanban_card_items',
    summary: 'Change requirements on a card.',
    description: 'Change requirements on a card — ' + ITEMS_DESCRIPTION,
    input: obj({ card: cardNo, ops: itemsSchema }, ['card', 'ops']),
    mutates: true, group: 'board',
    execute: (ctx, a) => patch(ctx, Number(a.card), {}, a.ops as ItemOp[]),
  },
  {
    name: 'kanban_card_pin',
    summary: 'Pin or unpin a card.',
    description: 'Pin or unpin a card. Pinned cards sit as a group at the top of their column ' +
      '(still sortable inside the group); unpinning drops the card back into the column\'s normal order. ' +
      'A plain on/off — pinning says nothing to the looper.',
    input: obj({ card: cardNo, state: oneOf(['on', 'off'], 'pinned or not') }, ['card', 'state']),
    mutates: true, group: 'board',
    execute: (ctx, a) => patch(ctx, Number(a.card), { pinned: a.state === 'on' }),
  },
  {
    name: 'kanban_card_move',
    summary: 'Move a card to a column.',
    description: 'Send card to the end of a status column.',
    input: obj({ card: cardNo, status: statusField('the column to move to') }, ['card', 'status']),
    mutates: true, group: 'board',
    execute: (ctx, a) => patch(ctx, Number(a.card), { status: a.status }),
  },
  {
    name: 'kanban_card_history',
    summary: "A card's past revisions.",
    description: "List a card's past revisions, newest first. Each revision is {changed_from, changed_at}: " +
      'the fields that changed and the value each had before. An archived card still answers; ' +
      'a deleted card has no history.',
    input: obj({ card: cardNo, limit: int('revisions to return (default 20, newest first)', 20) }, ['card']),
    mutates: false, group: 'board',
    async execute(ctx, a) {
      return { card: Number(a.card), revisions: await ctx.app.cards.revisions(ctx.project, Number(a.card), Number(a.limit ?? 20)) };
    },
  },
];
