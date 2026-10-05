// The looper's two board tools: a card's Auto plan / Auto build switch. Served
// from this app through the SDK's tools door; they write through the SDK's
// Cards like any card field (CardAutomation is where the write lands).
import { CardError, int, obj, oneOf, refusal, type ToolDefinition } from '@phantom-agent-sdk/backend';

const cardNo = int('card number — PHA-7 is card 7');

const autoSwitch = (field: 'auto_plan' | 'auto_build', column: string, job: string): ToolDefinition => ({
  name: `kanban_card_${field}`,
  summary: `The card's Auto ${field === 'auto_plan' ? 'plan' : 'build'} switch.`,
  description: `The card's Auto ${field === 'auto_plan' ? 'plan' : 'build'} switch — whether the supervisor ${job} while the card sits in ${column}. ` +
    'on/off overrides the project setting for this card; inherit clears the override so the project setting decides. ' +
    `Turning it on while the card is in ${column} starts the looper on it at once; kanban_card_move puts it there. ` +
    'The result states the switch as it now stands — report that.',
  input: obj({ card: cardNo, state: oneOf(['on', 'off', 'inherit'], 'inherit = follow the project setting') }, ['card', 'state']),
  mutates: true, group: 'board',
  async execute(ctx, args) {
    try {
      const { card } = await ctx.app.cards.update(ctx.project, Number(args.card), { [field]: args.state === 'inherit' ? null : args.state === 'on' }, undefined, ctx.client);
      return { card: card.number, title: card.title, status: card.status, [field]: card[field] };
    } catch (error) {
      if (error instanceof CardError) throw refusal(error.code, error.message);
      throw error;
    }
  },
});

export const boardTools: ToolDefinition[] = [
  autoSwitch('auto_plan', 'plan', 'plans it — has the coding agent write a plan, verifies it, and moves the card on'),
  autoSwitch('auto_build', 'in_progress', 'builds it — drives the coding agent and verifies the work against the repo'),
];
