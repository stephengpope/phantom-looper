// `phantom_looper.card_automation` (app migration 002): the looper's two
// switches on a card — auto_plan gates the plan column, auto_build gates
// in_progress; null inherits the project setting of the same name. The one
// owner of the table, and what the app's CardFieldsExtension (index.ts) is
// made of: the SDK carries `auto_plan` / `auto_build` on every card it
// answers and hands every write of them here, inside its own transaction.
import { eq, inArray } from 'drizzle-orm';
import type { Drizzle, Transaction, Settings, ProjectRow, Card, CardFieldsExtension } from '@phantom-agent-sdk/backend';
import { cardAutomation } from '../storage/schema.js';

/** The switches as the looper reads them off a card. */
export interface AutomationSwitches { auto_plan: boolean | null; auto_build: boolean | null }

const SWITCHES = ['auto_plan', 'auto_build'] as const;
const asSwitch = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

export class CardAutomation {
  constructor(private readonly database: Drizzle, private readonly settings: Settings) {}

  /** The two switches off a card the SDK answered (its fields ride under
   *  their names; a card typed narrower than the SDK's Card still carries them). */
  of(card: object): AutomationSwitches {
    const fields = card as Partial<Card>;
    return { auto_plan: asSwitch(fields.auto_plan), auto_build: asSwitch(fields.auto_build) };
  }

  /** The two fields as the SDK's API accepts them (CardFieldsExtension.schema). */
  static readonly schema: CardFieldsExtension['schema'] = {
    auto_plan: { type: ['boolean', 'null'], description: "The looper's per-card switch for the plan column: true/false overrides the project's auto_plan setting; null inherits it." },
    auto_build: { type: ['boolean', 'null'], description: "The looper's per-card switch for the in_progress column: true/false overrides the project's auto_build setting; null inherits it." },
  };

  /** The switches of these cards, by card id; a card with no row is absent. */
  async read(cardIds: number[]): Promise<Map<number, Record<string, unknown>>> {
    if (!cardIds.length) return new Map();
    const rows = await this.database.select().from(cardAutomation).where(inArray(cardAutomation.cardId, cardIds));
    return new Map(rows.map((row) => [row.cardId, { auto_plan: row.autoPlan, auto_build: row.autoBuild }]));
  }

  /** Write a card's switches (the ones named) inside the SDK's transaction;
   *  answers what the changed ones were before, for the card's history. */
  async write(cardId: number, fields: Record<string, unknown>, transaction: Transaction): Promise<Record<string, unknown>> {
    const [prior] = await transaction.select().from(cardAutomation).where(eq(cardAutomation.cardId, cardId)).for('update');
    const before: AutomationSwitches = { auto_plan: prior?.autoPlan ?? null, auto_build: prior?.autoBuild ?? null };
    const next: AutomationSwitches = { ...before };
    const changed: Record<string, unknown> = {};
    for (const name of SWITCHES) {
      if (!(name in fields)) continue;
      const value = asSwitch(fields[name]);
      if (value === before[name]) continue;
      next[name] = value;
      changed[name] = before[name];
    }
    if (!Object.keys(changed).length) return {};
    await transaction.insert(cardAutomation).values({ cardId, autoPlan: next.auto_plan, autoBuild: next.auto_build })
      .onConflictDoUpdate({ target: cardAutomation.cardId, set: { autoPlan: next.auto_plan, autoBuild: next.auto_build } });
    return changed;
  }

  /** The project's defaults — what a null switch inherits — and the layer
   *  each came from, for the card editor. Rides every board payload. */
  async defaults(project: ProjectRow): Promise<Record<string, unknown>> {
    const plan = await this.settings.resolveWithSource('auto_plan', { projectId: project.id });
    const build = await this.settings.resolveWithSource('auto_build', { projectId: project.id });
    return { auto_plan_default: Boolean(plan.value), auto_plan_source: plan.source,
      auto_build_default: Boolean(build.value), auto_build_source: build.source };
  }
}
