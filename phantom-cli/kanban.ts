// The card work behind both kanban tools: the Assistant's and the coding
// agent's, against one BoardStore. Screen actions (open the board, show a
// card) belong to the Assistant alone and stay with the window; everything
// that touches a card is here, once, so the two tools cannot drift apart.
import type { BoardStore, Card } from './board.js';
import type { KanbanArgs } from './voice.js';

/** What a card looks like in a tool result: the line you would read off the
 *  board. `get` returns the whole card instead. */
const cardSummary = (t: Card) =>
  ({ card: t.seq, title: t.title, status: t.status,
    ...(t.pinned ? { pinned: true } : {}),
    ...(t.blocked_reason ? { blocked: t.blocked_reason } : {}) });

/** The summary plus the checklists WITH their keys — what create/update/tick
 *  answer, so the agent copies keys from the result instead of guessing them
 *  from the text (the Assistant has no card read; this is where it sees them). */
const cardWithLists = (t: Card) => ({ ...cardSummary(t),
  ...(t.requirements.length ? { requirements: t.requirements } : {}) });

/** A column name as the agent said it → the board's real column. A voice
 *  transcript says "in progress", never "in_progress", so spaces/hyphens and
 *  case are forgiven; anything else is not a column. */
export const resolveColumn = (board: BoardStore, name: string): string | undefined => {
  const want = name.trim().toLowerCase().replace(/[\s_-]+/g, '_');
  return board.state.columns.find((c) => c.toLowerCase() === want);
};

/** The card work both kanban tools do — the Assistant's and the coding
 *  agent's — against one board store. Screen actions (open/close) belong to
 *  the Assistant alone and stay in App; everything that touches a card is
 *  here, once, so the two tools cannot drift apart. Every failure comes back
 *  as { error } — the store reverts a rejected write, so an `ok` here without
 *  checking would report a move that did not happen. */
export async function kanbanOps(board: BoardStore, args: KanbanArgs): Promise<unknown> {
  if (!board.state.loaded) await board.load();
  if (!board.state.columns.length) return { error: `board unavailable: ${board.state.error ?? 'no columns'}` };
  let status = args.status;
  if (status !== undefined) {
    const col = resolveColumn(board, status);
    if (!col) return { error: `no column "${status}" — the columns are: ${board.state.columns.join(', ')}` };
    status = col;
  }
  if (args.action === 'list') {
    return { prefix: board.state.prefix, columns: board.state.columns,
      cards: board.state.columns.flatMap((c) => board.cardsIn(c).map(cardSummary)) };
  }
  if (args.action === 'create') {
    if (!args.title) return { error: 'create needs a title' };
    try {
      const made = await board.create({ title: args.title, status,
        details: args.details,
        requirements: args.requirements?.map((c) => ({ ...c, done: c.done ?? false })) });
      return { ok: true, ...cardWithLists(made) };
    } catch (e) { return { error: (e as Error).message }; }
  }
  if (args.action === 'history') {
    // By seq straight to the server, not bySeq: a deleted card is not on the
    // board, and reading one that is gone is what history is for.
    if (args.card === undefined) return { error: 'history needs the card number' };
    try { return { card: args.card, revisions: await board.revisions(args.card, args.limit) }; }
    catch (e) { return { error: (e as Error).message }; }
  }
  // The board GET excludes archived cards, so a bySeq miss asks the server
  // for that number directly — "read card 7" / "restore card 7" must work on
  // a card that is off the board. The fetch adopts the card into the store.
  let t = args.card !== undefined ? board.bySeq(args.card) : undefined;
  if (!t && args.card !== undefined) {
    try { t = await board.fetchCard(args.card); }
    catch (e) { return { error: `could not read card ${args.card}: ${(e as Error).message}` }; }
  }
  if (!t) return { error: `no card ${args.card ?? '(none given)'} — pass the card number` };
  if (args.action === 'read') {
    return { card: t.seq, title: t.title, status: t.status,
    details: t.details, requirements: t.requirements,
    blocked_reason: t.blocked_reason, archived: t.archived };
  }
  if (args.action === 'move') {
    if (!status) return { error: 'move needs a status (column name)' };
    const failed = await board.move(t.id, status, 1e9);
    if (failed) return { error: failed };
  } else if (args.action === 'items') {
    if (!args.ops?.length) return { error: 'items needs ops: [{op, list, key?, text?, done?}]' };
    const failed = await board.items(t.id, args.ops);
    if (failed) return { error: failed };
  } else {
    const patch: Record<string, unknown> = {};
    for (const f of ['title', 'details', 'blocked_reason', 'auto_plan', 'auto_build', 'pinned', 'archived'] as const)
      if (args[f] !== undefined) patch[f] = args[f];
    if (status !== undefined) patch.status = status;
    if (args.requirements !== undefined)
      patch.requirements = args.requirements.map((c) => ({ ...c, done: c.done ?? false }));
    if (!Object.keys(patch).length) return { error: 'nothing to update' };
    const failed = await board.update(t.id, patch as Parameters<typeof board.update>[1]);
    if (failed) return { error: failed };
  }
  const fresh = board.state.cards.find((x) => x.id === t.id);
  const shape = args.action === 'move' ? cardSummary : cardWithLists;
  // A switch flip answers with the switch as it now stands — the effective
  // value, inherit spelled out — so the tool never has to guess what null means.
  const switchState = (v: boolean | null | undefined, fallback: boolean | undefined) =>
    v == null ? `inherit (workspace ${fallback ? 'on' : 'off'})` : v ? 'on' : 'off';
  const switches = args.auto_plan !== undefined || args.auto_build !== undefined
    ? { auto_plan: switchState(fresh?.auto_plan, board.state.autoPlanDefault),
      auto_build: switchState(fresh?.auto_build, board.state.autoBuildDefault) } : {};
  return { ok: true, ...(fresh ? shape(fresh) : {}), ...switches };
}
