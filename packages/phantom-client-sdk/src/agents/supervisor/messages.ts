// The loop-authored fixed messages: what the loop sends the coding agent
// and implants in the supervisor's conversation. Each one's FIRST LINE is
// frozen — the loop matches it against the conversations to know what was
// already sent. No prompt text lives here; ./prompt.ts is the document.
import { fill, firstLineOf } from '../../prompts/template.js';
import {
  PLAN_CARD, BUILD_FROM_PLAN, BUILD_FROM_CARD, PLAN_FORMAT, REPORT_FORMAT,
  IMPLANTED_REVIEWING_PLAN, IMPLANTED_REVIEWING_WORK, CARD_IS_BACK,
} from './prompt.js';

export interface CardShape {
  number: number; title: string; status: string; details: string;
  requirements: { key: string; text: string; done: boolean }[];
  blocked_reason?: string | null;
  resolution?: string | null;
}

const cardJson = (card: CardShape) =>
  JSON.stringify({ card: card.number, title: card.title, details: card.details, requirements: card.requirements }, null, 1);

export const firstLine = {
  planCard: (number: number) => firstLineOf(PLAN_CARD, { number }),
  buildFromPlan: (number: number) => firstLineOf(BUILD_FROM_PLAN, { number }),
  buildFromCard: (number: number) => firstLineOf(BUILD_FROM_CARD, { number }),
  reviewingPlan: (number: number) => firstLineOf(IMPLANTED_REVIEWING_PLAN, { number }),
  reviewingWork: (number: number) => firstLineOf(IMPLANTED_REVIEWING_WORK, { number }),
  cardIsBack: (number: number) => firstLineOf(CARD_IS_BACK, { number }),
};

export const toCodingAgent = {
  planCard: (card: CardShape) => fill(PLAN_CARD, { number: card.number, card: cardJson(card), planFormat: PLAN_FORMAT }),
  buildFromPlan: (card: CardShape) => fill(BUILD_FROM_PLAN, { number: card.number, card: cardJson(card), reportFormat: REPORT_FORMAT }),
  buildFromCard: (card: CardShape) => fill(BUILD_FROM_CARD, { number: card.number, card: cardJson(card), reportFormat: REPORT_FORMAT }),
  cardIsBack: (card: CardShape) => fill(CARD_IS_BACK, { number: card.number, resolution: card.resolution ?? '' }),
};

export const toSupervisor = {
  reviewingPlan: (card: CardShape) =>
    fill(IMPLANTED_REVIEWING_PLAN, { number: card.number, card: cardJson(card), planFormat: PLAN_FORMAT }),
  reviewingWork: (card: CardShape, opts: { planned: boolean }) =>
    fill(IMPLANTED_REVIEWING_WORK, { number: card.number, reportFormat: REPORT_FORMAT,
      cardSection: opts.planned ? '' : `The card:\n${cardJson(card)}`,
      contract: opts.planned
        ? 'the plan approved earlier in this conversation, as finally revised, beside the card'
        : 'the card above' }),
};
