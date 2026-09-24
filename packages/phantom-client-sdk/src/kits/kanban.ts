// The KANBAN kit — the workspace's task board, over the card routes. THE
// kanban kit for every client; a client that also has a screen adds its
// own UI-only tools (open the board, open a card) as a separate kit.
//
// Two builds of the same handler:
//   kanbanReadToolKit   — kanban_card_read only (the coding agent's board surface)
//   kanbanToolKit       — the whole board (list, read, create, update, items,
//                         move, history, auto switches, pin) — the assistant's
// plus the LOOP builds, bound to ONE card at build time so an agent in a
// run can never act on another card:
//   loopSupervisorToolKit(card, column) — kanban_card_move (the run-ending
//                         verdict; per-column choices) + kanban_card_items
//   loopBlockToolKit(card)              — kanban_card_block (the coder's one
//                         board power in a run; ends the run)
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { callRaw, type PhantomBackend } from '../backend.js';
import type { ToolKit, ToolKitContext } from '../toolkit.js';

export const DEFAULT_COLUMNS = ['backlog', 'plan', 'in_progress', 'blocked', 'done'];

export interface CardRow {
  number: number; title: string; status: string; details: string;
  requirements: { key: string; text: string; done: boolean }[];
  blocked_reason: string | null; archived: boolean;
  [k: string]: unknown;
}

export interface ItemOp { op: 'add' | 'edit' | 'remove' | 'tick'; key?: string; text?: string; done?: boolean }

/** The same read shape whichever side served the tool. */
export function renderCard(t: CardRow) {
  return { card: t.number, title: t.title, status: t.status, details: t.details,
    requirements: t.requirements, blocked_reason: t.blocked_reason, archived: t.archived };
}

const cardNo = z.number().int().describe('card number — PHA-7 is card 7');
const statusEnum = (columns: string[]) => columns.length ? z.enum(columns as [string, ...string[]]) : z.string();

/** The card routes, envelope unwrapped for the model: data on success, the
 *  server's refusal (written for the agent) on failure. */
function cardApi(backend: PhantomBackend, workspaceId: string) {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/cards`;
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T | { error: unknown }> => {
    const j = await callRaw<T>(backend, method, `${base}${path}`, body);
    return j.ok ? j.data as T : { error: j.error };
  };
  return {
    board: () => api<{ prefix: string; columns: string[]; cards: CardRow[] }>('GET', ''),
    read: async (n: number) => {
      const r = await api<{ cards: CardRow[] }>('GET', `?number=${n}`);
      if ('error' in r) return r;
      const t = r.cards[0];
      return t ? renderCard(t) : { error: `no card ${n} — pass the card number` };
    },
    create: (body: unknown) => api('POST', '', body),
    patch: (n: number, body: unknown) => api<{ card: CardRow }>('PATCH', `/${n}`, body),
    revisions: (n: number, limit: number) => api('GET', `/${n}/revisions?limit=${limit}`),
  };
}

const readTool = (api: ReturnType<typeof cardApi>, extra: string) => tool({
  description: 'One whole card — details and the requirements list, each item with its key ' +
    '(the handle kanban_card_items takes). ' + extra,
  inputSchema: z.object({ card: cardNo }),
  execute: ({ card }) => api.read(card),
});

const itemsSchema = z.array(z.object({
  op: z.enum(['add', 'edit', 'remove', 'tick']),
  key: z.string().optional().describe('the item — required for edit/remove/tick'),
  text: z.string().optional().describe('required for add; new wording for edit'),
  done: z.boolean().optional().describe('required for tick; optional starting state for add'),
})).min(1);

const ITEMS_DESCRIPTION = 'add, edit (reword), remove, tick — each op touches ONE item, ' +
  'named by its key; the rest of the list cannot be touched. Keys come back from kanban_card_read and every ' +
  'write result — copy them from there, never invent one. add needs only text (the server assigns the key, ' +
  'returned in the result). Ops apply in order, all-or-nothing. THE way to change the list — there is no ' +
  'whole-list send. Tick done true means you VERIFIED it, not that you wrote code for it.';

/** The coding agent's board surface: read only. */
export const kanbanReadToolKit: ToolKit = {
  name: 'kanban',
  mutatingToolNames: [],
  version: (ctx) => ctx.workspaceId,
  build(ctx: ToolKitContext): Promise<Record<string, Tool>> {
    const api = cardApi(ctx.backend, ctx.workspaceId);
    return Promise.resolve({
      kanban_card_read: readTool(api,
        'Read it before planning, and RE-read it when retrying or resuming — the card is the ' +
        'source of truth, not your memory of it. Cards are numbered: PHA-7 is card 7. ' +
        'Use the board only when the user points you at a card; a task needs no card.'),
    });
  },
};

/** The whole board. `columns` are the workspace's when they differ from the default. */
export function kanbanToolKit(columns: string[] = DEFAULT_COLUMNS): ToolKit {
  const fields = {
    title: z.string().optional(),
    details: z.string().optional(),
    status: statusEnum(columns).optional().describe('the column'),
    blocked_reason: z.string().nullable().optional(),
  };
  const autoSwitch = (api: ReturnType<typeof cardApi>, field: 'auto_plan' | 'auto_build', column: string, job: string) => tool({
    description: `The card's Auto ${field === 'auto_plan' ? 'plan' : 'build'} switch — whether the supervisor ${job} while the card sits in ${column}. ` +
      'on/off overrides the workspace setting for this card; inherit clears the override so the workspace setting decides. ' +
      `Turning it on while the card is in ${column} starts the looper on it at once; kanban_card_move puts it there. ` +
      'The result states the switch as it now stands — report that.',
    inputSchema: z.object({ card: cardNo, state: z.enum(['on', 'off', 'inherit']).describe('inherit = follow the workspace setting') }),
    execute: ({ card, state }) => api.patch(card, { [field]: state === 'inherit' ? null : state === 'on' }),
  });
  return {
    name: 'kanban',
    mutatingToolNames: ['kanban_card_create', 'kanban_card_update', 'kanban_card_items', 'kanban_card_move',
      'kanban_card_auto_plan', 'kanban_card_auto_build', 'kanban_card_pin'],
    version: (ctx) => ctx.workspaceId,
    build(ctx: ToolKitContext): Promise<Record<string, Tool>> {
      const api = cardApi(ctx.backend, ctx.workspaceId);
      return Promise.resolve({
        kanban_card_list: tool({
          description: 'Every column and card (number, title, status) — a card is what people also call an issue, ' +
            'task, todo, or ticket. Cards are numbered — PHA-7 is card 7. ' +
            'Call before referring to cards by number; numbers come from here, never invented.',
          inputSchema: z.object({}),
          execute: async () => {
            const b = await api.board();
            if ('error' in b) return b;
            return { prefix: b.prefix, cards: b.cards.map((c) => ({ card: c.number, title: c.title, status: c.status })) };
          },
        }),
        kanban_card_read: readTool(api, 'Read a card before changing items on one you did not just write — the keys come from here.'),
        kanban_card_create: tool({
          description: 'Creates a card on the board (task, issue, bug, ticket, or todo).',
          inputSchema: z.object({ ...fields,
            requirements: z.array(z.object({ text: z.string(), done: z.boolean().optional() })).optional()
              .describe('what must be true for the card to be done — done means VERIFIED, not written') }),
          execute: (args) => api.create(args),
        }),
        kanban_card_update: tool({
          description: 'Change the card\'s FIELDS: title, details, column, blocked_reason (blocked means status ' +
            '"blocked"), archived true takes it off the board. Requirements are not fields — change those with kanban_card_items.',
          inputSchema: z.object({ card: cardNo, archived: z.boolean().optional(), ...fields }),
          execute: ({ card, ...rest }) => api.patch(card, rest),
        }),
        kanban_card_items: tool({
          description: 'Change requirements on a card — ' + ITEMS_DESCRIPTION,
          inputSchema: z.object({ card: cardNo, ops: itemsSchema }),
          execute: ({ card, ops }) => api.patch(card, { items: ops }),
        }),
        kanban_card_auto_plan: autoSwitch(api, 'auto_plan', 'plan',
          'plans it — has the coding agent write a plan, verifies it, and moves the card on'),
        kanban_card_auto_build: autoSwitch(api, 'auto_build', 'in_progress',
          'builds it — drives the coding agent and verifies the work against the repo'),
        kanban_card_pin: tool({
          description: 'Pin or unpin a card. Pinned cards sit as a group at the top of their column ' +
            '(still sortable inside the group); unpinning drops the card back into the column\'s normal order. ' +
            'A plain on/off — pinning says nothing to the looper.',
          inputSchema: z.object({ card: cardNo, state: z.enum(['on', 'off']) }),
          execute: ({ card, state }) => api.patch(card, { pinned: state === 'on' }),
        }),
        kanban_card_move: tool({
          description: 'Send card to the end of a status column.',
          inputSchema: z.object({ card: cardNo, status: statusEnum(columns).describe('the column to move to') }),
          execute: ({ card, status }) => api.patch(card, { status }),
        }),
        kanban_card_history: tool({
          description: "List a card's past revisions, newest first. Each revision is {changed_from, changed_at}: " +
            'the fields that changed and the value each had before. An archived card still answers; ' +
            'a deleted card has no history.',
          inputSchema: z.object({ card: cardNo, limit: z.number().int().optional().describe('revisions to return (default 20, newest first)') }),
          execute: ({ card, limit }) => api.revisions(card, limit ?? 20),
        }),
      });
    },
  };
}

// ── the loop builds: bound to ONE card ────────────────────────────────────

/** The run-ending tools. A turn that calls one is terminal: the loop breaks
 *  on the card's status change. */
export const ENDING_TOOLS = ['kanban_card_move', 'kanban_card_block'] as const;

/** Which statuses the supervisor's move OFFERS, per loop column. */
export const SUPERVISOR_MOVES = {
  plan: ['in_progress', 'blocked'],
  in_progress: ['done', 'blocked'],
} as const;
export type LoopColumn = keyof typeof SUPERVISOR_MOVES;

export function loopSupervisorToolKit(cardNumber: number, column: LoopColumn): ToolKit {
  const moves = SUPERVISOR_MOVES[column];
  const verdictLine = column === 'plan'
    ? '"in_progress" declares the plan verified and ready to build; '
    : '"done" declares you verified EVERY requirement yourself against the repo; ';
  return {
    name: 'loop-supervisor',
    // Board powers in a run are the point of the run: not trimmed by readonly.
    mutatingToolNames: [],
    version: () => `${cardNumber}:${column}`,
    build(ctx: ToolKitContext): Promise<Record<string, Tool>> {
      const api = cardApi(ctx.backend, ctx.workspaceId);
      return Promise.resolve({
        kanban_card_move: tool({
          description: `Move card ${cardNumber}. THIS ENDS THE RUN — the moment you call this, the ` +
            'conversation with the coding agent is over and no further message passes in either ' +
            'direction. This is your verdict, not a status update: ' + verdictLine +
            '"blocked" hands the card to a human with your reason. Call it only when your verdict ' +
            'is final. Until then, reply in text — your message goes to the coding agent and the ' +
            'work continues.',
          inputSchema: z.object({
            status: z.enum(moves as unknown as [string, ...string[]]).describe('the verdict'),
            reason: z.string().describe('why — shown to the human as blocked_reason when blocking'),
          }),
          execute: ({ status, reason }) => api.patch(cardNumber, {
            status, ...(status === 'blocked' ? { blocked_reason: reason, resolution: null } : { blocked_reason: null, resolution: null }),
          }),
        }),
        kanban_card_items: tool({
          description: `Change requirements on card ${cardNumber} — ` + ITEMS_DESCRIPTION,
          inputSchema: z.object({ ops: itemsSchema }),
          execute: ({ ops }) => api.patch(cardNumber, { items: ops }),
        }),
      });
    },
  };
}

export function loopBlockToolKit(cardNumber: number): ToolKit {
  return {
    name: 'loop-block',
    mutatingToolNames: [],   // survives plan mode by design
    version: () => String(cardNumber),
    build(ctx: ToolKitContext): Promise<Record<string, Tool>> {
      const api = cardApi(ctx.backend, ctx.workspaceId);
      return Promise.resolve({
        kanban_card_block: tool({
          description: `Block card ${cardNumber} for a human decision. THIS ENDS THE RUN — the conversation ` +
            'with your supervisor stops and the card lands on the board with your reason. This is your ' +
            'only board power, for one situation: a genuine human call — a broken premise or a preference ' +
            'no agent owns. A problem you can fix, or a question your supervisor can answer, is never a ' +
            'block: ask in text first.',
          inputSchema: z.object({ reason: z.string().describe('what the human must decide — shown on the board') }),
          execute: ({ reason }) => api.patch(cardNumber, { status: 'blocked', blocked_reason: reason, resolution: null }),
        }),
      });
    },
  };
}
