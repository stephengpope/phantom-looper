// The supervisor's wiring — the code that fills ./supervisor.ts (the
// document). No prompt text lives here. The loop is a dialogue: these are
// the loop-authored fixed messages; everything else the agents say crosses
// verbatim, and a status TOOL call ends the run (core/llm/tools/kanban.ts).
import { fill, firstLineOf } from '../template.js';
import { STAKEHOLDERS } from '../stakeholders.js';
import { VALUES } from '../values.js';
import { COMMUNICATION } from '../communication.js';
import {
  SYSTEM, PLAN_CARD, BUILD_FROM_PLAN, BUILD_FROM_CARD, PLAN_FORMAT, REPORT_FORMAT,
  IMPLANTED_REVIEWING_PLAN, IMPLANTED_REVIEWING_WORK, CARD_IS_BACK,
} from './supervisor.js';

export interface CardShape {
  seq: number; title: string; status: string; user_story: string; details: string;
  requirements: { key: string; text: string; done: boolean }[];
  blocked_reason?: string | null;
  /** The human's reply to a block — why the card came back. */
  resolution?: string | null;
}

/** The {card} blank: the card as JSON, requirement keys included (ticks go by key). */
const cardJson = (card: CardShape) =>
  JSON.stringify({ card: card.seq, title: card.title, user_story: card.user_story,
    details: card.details, requirements: card.requirements }, null, 1);

export function systemPrompt(): string {
  return fill(SYSTEM, { stakeholders: STAKEHOLDERS, values: VALUES, communication: COMMUNICATION });
}

/** The frozen first lines, derived from the templates' own line 1 — what the
 *  loop matches against the conversations to know what was already sent. */
export const firstLine = {
  planCard: (seq: number) => firstLineOf(PLAN_CARD, { seq }),
  buildFromPlan: (seq: number) => firstLineOf(BUILD_FROM_PLAN, { seq }),
  buildFromCard: (seq: number) => firstLineOf(BUILD_FROM_CARD, { seq }),
  reviewingPlan: (seq: number) => firstLineOf(IMPLANTED_REVIEWING_PLAN, { seq }),
  reviewingWork: (seq: number) => firstLineOf(IMPLANTED_REVIEWING_WORK, { seq }),
  cardIsBack: (seq: number) => firstLineOf(CARD_IS_BACK, { seq }),
};

/** The messages the loop sends the coding agent — each starts a real coding
 *  turn (see the document for which fires when). */
export const toCodingAgent = {
  planCard: (card: CardShape) => fill(PLAN_CARD, { seq: card.seq, card: cardJson(card), planFormat: PLAN_FORMAT }),
  buildFromPlan: (card: CardShape) => fill(BUILD_FROM_PLAN, { seq: card.seq, card: cardJson(card), reportFormat: REPORT_FORMAT }),
  buildFromCard: (card: CardShape) => fill(BUILD_FROM_CARD, { seq: card.seq, card: cardJson(card), reportFormat: REPORT_FORMAT }),
  /** The card came back from blocked (the builder's answer rides along) or
   *  from done (no answer — the line vanishes). */
  cardIsBack: (card: CardShape) => fill(CARD_IS_BACK,
    { seq: card.seq, resolution: card.resolution ?? '' }),
};

/** The implanted briefings — one per phase, written into the supervisor's
 *  transcript before that phase's first coder reply is copied in. USER role,
 *  never starts a turn. `planned` is the loop's own knowledge of whether a
 *  plan phase happened: it decides whether the work briefing carries the
 *  card (only the conversation's opening briefing does) and what the
 *  contract line names — the model never infers the phase. */
export const toSupervisor = {
  reviewingPlan: (card: CardShape) =>
    fill(IMPLANTED_REVIEWING_PLAN, { seq: card.seq, card: cardJson(card), planFormat: PLAN_FORMAT }),
  reviewingWork: (card: CardShape, opts: { planned: boolean }) =>
    fill(IMPLANTED_REVIEWING_WORK, { seq: card.seq, reportFormat: REPORT_FORMAT,
      cardSection: opts.planned ? '' : `The card:\n${cardJson(card)}`,
      contract: opts.planned
        ? 'the plan approved earlier in this conversation, as finally revised, beside the card'
        : 'the card above' }),
};
