// The looper's pure decisions — canTurn, which kickoff is owed, and the
// STEP RULE that drives the dialogue — factored out of the engine so every
// rule is unit-tested without a server, a model, or a clock
// (test/looper-logic.test.ts).
//
// The transcripts ARE the state: whose turn it is derives from comparing the
// two conversations, and the same rule runs turn 1, turn 50, and the turn
// after a restart. Copies are verbatim, which is what makes the comparison a
// plain ordered text match.
import type { ModelMessage } from 'ai';
import {
  firstLine, toCodingAgent, toSupervisor, type CardShape,
} from '../../core/llm/prompts/supervisor/wiring.js';
import { ENDING_TOOLS } from '../../core/llm/tools/kanban.js';

export const LOOP_COLUMNS = ['plan', 'in_progress'] as const;

/** The one word a locked-out window shows for what is happening in the
 *  session right now: `planning`, `building`, `reviewing`. It rides as the
 *  lock's LABEL — display only; the lock identity stays the looper's one
 *  client id, which is what release compares against.
 *
 *  Per seat, because the seats do different work and the label is all a
 *  locked-out window has to go on: a coding session is the CODING agent at
 *  work and the card's column says at what (`plan` → planning,
 *  `in_progress` → building); only the supervisor's own record is the
 *  supervisor. No card and no agent name: the window's status line already
 *  carries the card, and the session it is drawn on says whose it is. */
export function heldBy(seat: 'coding' | 'supervisor', cardStatus: string): string {
  if (seat === 'supervisor') return 'reviewing';
  return cardStatus === 'plan' ? 'planning' : 'building';
}

export interface CardRow extends CardShape {
  id: number;
  auto_plan: boolean | null;
  auto_build: boolean | null;
  archived: boolean;
}

/** A card runs when the switch for ITS loop column says so: `plan` is gated
 *  by auto_plan, `in_progress` by auto_build — the card's own tri-state, or,
 *  unset, the workspace's setting of the same name. The break is this same
 *  predicate no longer matching (the card left the columns, or its column's
 *  switch is off). */
export function canTurn(card: CardRow, defaults: { plan: boolean; build: boolean }): boolean {
  if (card.archived) return false;
  if (card.status === 'plan') return card.auto_plan ?? defaults.plan;
  if (card.status === 'in_progress') return card.auto_build ?? defaults.build;
  return false;
}

const userTexts = (messages: ModelMessage[]): string[] =>
  messages.filter((m) => m.role === 'user')
    .map((m) => typeof m.content === 'string' ? m.content
      : m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(''));

/** Was a fixed message already sent? Read off the conversation itself — the
 *  templates' first lines are frozen, so the session IS the state. */
export function wasSent(messages: ModelMessage[], firstLine: string): boolean {
  return userTexts(messages).some((t) => t.startsWith(firstLine));
}

/** Which fixed kickoff is still owed to the coding agent, if any.
 *  null = the conversation is underway.
 *
 *    card → plan                       new/empty conversation → 1: plan
 *    card → in_progress, planned here  same session           → 2: execute the plan
 *    card → in_progress, no plan ever  new/empty conversation → 3: execute directly
 */
export function unsentKickoff(card: CardShape, messages: ModelMessage[]): { text: string; planMode: boolean } | null {
  if (card.status === 'plan') {
    return wasSent(messages, firstLine.planCard(card.seq))
      ? null : { text: toCodingAgent.planCard(card), planMode: true };
  }
  if (card.status === 'in_progress') {
    if (wasSent(messages, firstLine.buildFromPlan(card.seq))
      || wasSent(messages, firstLine.buildFromCard(card.seq))) return null;
    return wasSent(messages, firstLine.planCard(card.seq))
      ? { text: toCodingAgent.buildFromPlan(card), planMode: false }
      : { text: toCodingAgent.buildFromCard(card), planMode: false };
  }
  return null;
}

/** Entering `plan` is a NEW session, always: a session made before the card's
 *  latest arrival in plan belongs to the previous run and is unlinked.
 *  The transition time comes from the card's revision history — the newest
 *  revision whose old values include `status` is the move into the current
 *  column. No transition on record = the card was born here; the session
 *  (made for it) continues. */
export function needsFreshSession(
  cardStatus: string, sessionCreatedAt: Date | null, lastStatusChangeAt: Date | null,
): boolean {
  if (cardStatus !== 'plan') return false;
  if (!sessionCreatedAt) return true;
  if (!lastStatusChangeAt) return false;
  return lastStatusChangeAt.getTime() > sessionCreatedAt.getTime();
}

// ── the step rule ───────────────────────────────────────────────────────────

/** What one agent turn amounts to: everything between two user messages.
 *  `text` is every word the agent wrote, in order; `terminal` means the turn
 *  called a run-ending tool — nothing from a terminal turn ever crosses. */
interface Turn { text: string; terminal: boolean }

const NO_REPLY = '(no reply)';

function assistantTurns(messages: ModelMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const m of messages) {
    if (m.role === 'user') { current = null; continue; }
    if (!current) { current = { text: '', terminal: false }; turns.push(current); }
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string') {
      current.text = [current.text, m.content].filter(Boolean).join('\n\n');
      continue;
    }
    for (const p of m.content) {
      if (p.type === 'text' && p.text.trim()) {
        current.text = [current.text, p.text.trim()].filter(Boolean).join('\n\n');
      } else if (p.type === 'tool-call' && (ENDING_TOOLS as readonly string[]).includes(p.toolName)) {
        current.terminal = true;
      }
    }
  }
  return turns;
}

/** The agent's reply from each turn, in order — what gets pasted into the
 *  other agent's conversation. A turn that called an ending tool is skipped:
 *  the run is over, nothing crosses. Empty text becomes a placeholder so the
 *  two sides never drift out of step. */
export function replies(messages: ModelMessage[]): string[] {
  return assistantTurns(messages)
    .filter((t) => !t.terminal)
    .map((t) => t.text || NO_REPLY);
}

/** How many of these replies, walked in order, the other agent already
 *  received as user messages. Verbatim equality — copies are verbatim, so
 *  this is exact; the ordered walk keeps identical texts honest. */
function repliesReceived(sent: string[], received: string[]): number {
  let i = 0;
  for (const r of received) if (i < sent.length && r === sent[i]) i++;
  return i;
}

/** The briefings the supervisor has not been sent yet — one per
 *  phase the CODER has entered (read off its kickoffs), each IMPLANTED
 *  before that phase's first copied reply. Self-contained: the assignment
 *  plus the reply's format; the card rides only the briefing that opens the
 *  conversation. */
function unsentBriefings(card: CardShape, coder: ModelMessage[], supervisor: ModelMessage[]): string[] {
  const supTexts = userTexts(supervisor);
  const has = (line: string) => supTexts.some((t) => t.startsWith(line));
  const seeds: string[] = [];
  const planned = wasSent(coder, firstLine.planCard(card.seq));
  if (planned && !has(firstLine.reviewingPlan(card.seq)))
    seeds.push(toSupervisor.reviewingPlan(card));
  const building = wasSent(coder, firstLine.buildFromPlan(card.seq))
    || wasSent(coder, firstLine.buildFromCard(card.seq));
  if (building && !has(firstLine.reviewingWork(card.seq)))
    seeds.push(toSupervisor.reviewingWork(card, { planned }));
  return seeds;
}

/** The one owed step, read off the two transcripts. Called only when no
 *  kickoff is owed (unsentKickoff returned null):
 *
 *  - an uncopied coder turn  → run the SUPERVISOR (`append` = any briefings
 *    still missing + the uncopied turn texts, in order, all user messages)
 *  - an undelivered supervisor turn → run the CODER with it, verbatim
 *  - neither → the card re-entered after a run ended (a human moved it back
 *    from blocked or done) → run the CODER with the return message
 *  - null → nothing to do (defensive: an empty conversation owes a kickoff,
 *    not a step)
 */
export type LoopStep =
  | { kind: 'supervisor'; append: string[] }
  | { kind: 'deliver'; text: string }
  | { kind: 'return'; text: string }
  | null;

export function nextStep(card: CardShape, coder: ModelMessage[], supervisor: ModelMessage[]): LoopStep {
  if (!coder.length) return null;

  const coderSent = replies(coder);
  const unported = coderSent.slice(repliesReceived(coderSent, userTexts(supervisor)));
  if (unported.length) {
    return { kind: 'supervisor', append: [...unsentBriefings(card, coder, supervisor), ...unported] };
  }

  const supSent = replies(supervisor);
  const undelivered = supSent.slice(repliesReceived(supSent, userTexts(coder)));
  if (undelivered.length) return { kind: 'deliver', text: undelivered.join('\n\n') };

  return { kind: 'return', text: toCodingAgent.cardIsBack(card) };
}
