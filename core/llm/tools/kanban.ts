/**
 * The KANBAN kit for headless callers — thin clients on the card routes, the
 * same pattern as the skills and web kits. Needs: a phantom-backend and a
 * workspace.
 *
 * Three builds share this file:
 * - `kanbanReadTool` — the coding agent's board surface everywhere:
 *   `kanban_card_read` (in the cli the same tool is wired through the
 *   BoardStore instead so an open board repaints).
 * - `loopSupervisorTools` — the supervisor's board powers INSIDE a loop run:
 *   `kanban_card_move` (per-column choices, bound to THE card — calling it
 *   ends the run) and `kanban_card_items` (requirement changes by key).
 * - `loopBlockTool` — the coding agent's ONE board mutation inside a loop
 *   run: `kanban_card_block`, bound to THE card, ends the run.
 *
 * The run-ending contract lives in these DESCRIPTIONS on purpose: a tool's
 * description reaches the agent on every turn, unlike a frozen prompt.
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod';

export interface KanbanToolsConfig {
  baseUrl: string;
  apiKey: string;
  workspaceId: string;
  fetch?: typeof fetch;
}

/** The loop builds act on ONE card — fixed at build time, no card input, so
 *  an agent can never move or block a card other than the one it is running. */
export interface LoopCardConfig extends KanbanToolsConfig {
  /** The card's row id (the PATCH route's handle). */
  cardId: number;
  /** The card's number — what the descriptions call it. */
  seq: number;
  /** Sent as x-phantom-looper-client on every write, so the server knows the
   *  LOOP moved the card (the looper passes its own id). Without it a
   *  supervisor's move is indistinguishable from a person's. */
  clientId?: string;
}

/** The run-ending tools. A turn that calls one is terminal: the loop breaks
 *  on the card's status change, and nothing from that turn crosses to the
 *  other agent (the step rule reads these names off the transcript). */
export const ENDING_TOOLS = ['kanban_card_move', 'kanban_card_block'] as const;

/** Which statuses the supervisor's move tool OFFERS, per loop column — moving
 *  is the verdict, so only the column's real exits exist. */
export const SUPERVISOR_MOVES = {
  plan: ['in_progress', 'blocked'],
  in_progress: ['done', 'blocked'],
} as const;
export type LoopColumn = keyof typeof SUPERVISOR_MOVES;

interface CardRow {
  seq: number; title: string; status: string; user_story: string; details: string;
  requirements: { key: string; text: string; done: boolean }[];
  blocked_reason: string | null; archived: boolean;
}

/** The same read shape the cli's handler returns, so a transcript reads the
 *  same whichever side served the tool. */
export function renderCard(t: CardRow) {
  return { card: t.seq, title: t.title, status: t.status, user_story: t.user_story,
    details: t.details, requirements: t.requirements,
    blocked_reason: t.blocked_reason, archived: t.archived };
}

const headers = (cfg: KanbanToolsConfig, body?: boolean) => ({
  authorization: `Bearer ${cfg.apiKey}`,
  ...(body ? { 'content-type': 'application/json' } : {}),
});

/** PATCH one card and hand the envelope's data (or error) back to the agent. */
async function patchCard(cfg: LoopCardConfig, body: unknown): Promise<unknown> {
  const f = cfg.fetch ?? fetch;
  const r = await f(`${cfg.baseUrl}/workspaces/${cfg.workspaceId}/cards/${cfg.cardId}`, {
    method: 'PATCH',
    headers: { ...headers(cfg, true), ...(cfg.clientId ? { 'x-phantom-looper-client': cfg.clientId } : {}) },
    body: JSON.stringify(body),
  });
  const j = await r.json() as { ok: boolean; data?: unknown; error?: unknown };
  return j.ok ? j.data : { error: j.error };
}

export function kanbanReadTool(cfg: KanbanToolsConfig): Record<string, Tool> {
  const f = cfg.fetch ?? fetch;
  return {
    kanban_card_read: tool({
      description: 'One whole card — user story, details, and the requirements list, each item with its key. ' +
        'Read it before planning, and RE-read it when retrying or resuming — the card is the source of ' +
        'truth, not your memory of it. Cards are numbered: PHA-7 is card 7.',
      inputSchema: z.object({ card: z.number().int().describe('card number — PHA-7 is card 7') }),
      execute: async ({ card }) => {
        // The seq lookup, not the board list: one card back, archived or not.
        const r = await f(`${cfg.baseUrl}/workspaces/${cfg.workspaceId}/cards?seq=${card}`, {
          headers: headers(cfg),
        });
        const j = await r.json() as { ok: boolean; data?: { cards: CardRow[] }; error?: unknown };
        if (!j.ok) return { error: j.error };
        const t = j.data!.cards[0];
        if (!t) return { error: `no card ${card} — pass the card number` };
        return renderCard(t);
      },
    }),
  };
}

/** The supervisor's board powers for one loop run: the run-ending move and
 *  the requirements tool, both bound to THE card. Built fresh each turn so
 *  the move offers exactly the current column's exits. */
export function loopSupervisorTools(cfg: LoopCardConfig, column: LoopColumn): Record<string, Tool> {
  const moves = SUPERVISOR_MOVES[column];
  const verdictLine = column === 'plan'
    ? '"in_progress" declares the plan verified and ready to build; '
    : '"done" declares you verified EVERY requirement yourself against the repo; ';
  return {
    kanban_card_move: tool({
      description: `Move card ${cfg.seq}. THIS ENDS THE RUN — the moment you call this, the ` +
        'conversation with the coding agent is over and no further message passes in either ' +
        'direction. This is your verdict, not a status update: ' + verdictLine +
        '"blocked" hands the card to a human with your reason. Call it only when your verdict ' +
        'is final. Until then, reply in text — your message goes to the coding agent and the ' +
        'work continues.',
      inputSchema: z.object({
        status: z.enum(moves as unknown as [string, ...string[]]).describe('the verdict'),
        reason: z.string().describe('why — shown to the human as blocked_reason when blocking'),
      }),
      execute: async ({ status, reason }) => patchCard(cfg, {
        status,
        ...(status === 'blocked'
          ? { blocked_reason: reason, resolution: null }
          : { blocked_reason: null, resolution: null }),
      }),
    }),
    kanban_card_items: tool({
      description: `Change requirements on card ${cfg.seq} — add, edit (reword), remove, tick — each op ` +
        'touches ONE item, named by its key; the rest of the list cannot be touched. Keys come back from ' +
        'kanban_card_read and every write result — copy them from there, never invent one. add needs only ' +
        'text (the server assigns the key, returned in the result). Ops apply in order, all-or-nothing. ' +
        'THE way to change the list — there is no whole-list send. Tick done true means you VERIFIED it ' +
        'yourself, not that the coding agent claims it.',
      inputSchema: z.object({
        ops: z.array(z.object({
          op: z.enum(['add', 'edit', 'remove', 'tick']),
          key: z.string().optional().describe('the item — required for edit/remove/tick'),
          text: z.string().optional().describe('required for add; new wording for edit'),
          done: z.boolean().optional().describe('required for tick; optional starting state for add'),
        })).min(1),
      }),
      execute: async ({ ops }) => patchCard(cfg, { items: ops }),
    }),
  };
}

/** The coding agent's ONE board mutation inside a loop run — bound to THE
 *  card, survives plan mode (it is not part of any readonly-trimmed kit). */
export function loopBlockTool(cfg: LoopCardConfig): Record<string, Tool> {
  return {
    kanban_card_block: tool({
      description: `Block card ${cfg.seq} for a human decision. THIS ENDS THE RUN — the conversation ` +
        'with your supervisor stops and the card lands on the board with your reason. This is your ' +
        'only board power, for one situation: a genuine human call — a broken premise or a preference ' +
        'no agent owns. A problem you can fix, or a question your supervisor can answer, is never a ' +
        'block: ask in text first.',
      inputSchema: z.object({
        reason: z.string().describe('what the human must decide — shown on the board'),
      }),
      execute: async ({ reason }) => patchCard(cfg, {
        status: 'blocked', blocked_reason: reason, resolution: null,
      }),
    }),
  };
}
