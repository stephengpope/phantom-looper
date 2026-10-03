// The card run's own tools, as client-SDK kits: the coding agent's ONE board
// power (block) and the supervisor's two (the run-ending move, the
// requirements). Each is bound to THE card at build time — no card input,
// so neither agent can ever act on a card other than the one it is running.
// Writes go through the API like every other client's, under the run's
// lock identity, so the server knows a card run moved the card.
import { jsonSchema, tool, type Tool } from 'ai';
import type { ToolKit, ToolKitContext } from 'phantom-client-sdk';

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

export interface CardRunCard { projectId: string; number: number }

/** PATCH the card and hand the envelope's data (or error) back to the agent. */
async function patchCard(ctx: ToolKitContext, card: CardRunCard, body: unknown): Promise<unknown> {
  const envelope = await ctx.backend.callRaw('PATCH', `/projects/${card.projectId}/cards/${card.number}`, body);
  return envelope.ok ? envelope.data : { error: envelope.error };
}

/** The coding agent's ONE board mutation inside a card run — works in plan
 *  mode too (blocking is not a change to the files). */
export function codingAgentCardKit(card: CardRunCard): ToolKit {
  return {
    name: 'card-run',
    build(ctx) {
      const tools: Record<string, Tool> = {
        kanban_card_block: tool({
          description: `Block card ${card.number} for a human decision. THIS ENDS THE RUN — the conversation ` +
            'with your supervisor stops and the card lands on the board with your reason. This is your ' +
            'only board power, for one situation: a genuine human call — a broken premise or a preference ' +
            'no agent owns. A problem you can fix, or a question your supervisor can answer, is never a ' +
            'block: ask in text first.',
          inputSchema: jsonSchema<{ reason: string }>({ type: 'object', required: ['reason'], additionalProperties: false,
            properties: { reason: { type: 'string', description: 'what the human must decide — shown on the board' } } }),
          execute: ({ reason }) => patchCard(ctx, card, { status: 'blocked', blocked_reason: reason, resolution: null }),
        }),
      };
      return Promise.resolve({ tools, mutating: [] });
    },
  };
}

/** The supervisor's board powers for one card run: the run-ending move and
 *  the requirements tool. Built fresh each turn so the move offers exactly
 *  the current column's exits. */
export function supervisorCardKit(card: CardRunCard, column: LoopColumn): ToolKit {
  const moves = SUPERVISOR_MOVES[column];
  const verdictLine = column === 'plan'
    ? '"in_progress" declares the plan verified and ready to build; '
    : '"done" declares you verified EVERY requirement yourself against the repo; ';
  return {
    name: 'card-run',
    build(ctx) {
      const tools: Record<string, Tool> = {
        kanban_card_move: tool({
          description: `Move card ${card.number}. THIS ENDS THE RUN — the moment you call this, the ` +
            'conversation with the coding agent is over and no further message passes in either ' +
            'direction. This is your verdict, not a status update: ' + verdictLine +
            '"blocked" hands the card to a human with your reason. Call it only when your verdict ' +
            'is final. Until then, reply in text — your message goes to the coding agent and the ' +
            'work continues.',
          inputSchema: jsonSchema<{ status: string; reason: string }>({ type: 'object', required: ['status', 'reason'], additionalProperties: false,
            properties: { status: { type: 'string', enum: [...moves], description: 'the verdict' },
              reason: { type: 'string', description: 'why — shown to the human as blocked_reason when blocking' } } }),
          execute: ({ status, reason }) => patchCard(ctx, card, {
            status,
            ...(status === 'blocked' ? { blocked_reason: reason, resolution: null } : { blocked_reason: null, resolution: null }),
          }),
        }),
        kanban_card_items: tool({
          description: `Change requirements on card ${card.number} — add, edit (reword), remove, tick — each op ` +
            'touches ONE item, named by its key; the rest of the list cannot be touched. Keys come back from ' +
            'kanban_card_read and every write result — copy them from there, never invent one. add needs only ' +
            'text (the server assigns the key, returned in the result). Ops apply in order, all-or-nothing. ' +
            'THE way to change the list — there is no whole-list send. Tick done true means you VERIFIED it ' +
            'yourself, not that the coding agent claims it.',
          inputSchema: jsonSchema<{ ops: unknown[] }>({ type: 'object', required: ['ops'], additionalProperties: false,
            properties: { ops: { type: 'array', minItems: 1, items: { type: 'object', required: ['op'], additionalProperties: false,
              properties: {
                op: { type: 'string', enum: ['add', 'edit', 'remove', 'tick'] },
                key: { type: 'string', description: 'the item — required for edit/remove/tick' },
                text: { type: 'string', description: 'required for add; new wording for edit' },
                done: { type: 'boolean', description: 'required for tick; optional starting state for add' },
              } } } } }),
          execute: ({ ops }) => patchCard(ctx, card, { items: ops }),
        }),
      };
      return Promise.resolve({ tools, mutating: [] });
    },
  };
}
