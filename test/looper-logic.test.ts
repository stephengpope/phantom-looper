// The looper's pure rules (phantom-backend/looper/logic.ts + the supervisor
// prompt module + the loop's card-bound tools): eligibility, the three fixed
// kickoffs and their discrimination, and the STEP RULE that drives the
// dialogue — whose turn is next, read off the two transcripts alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage, Tool } from 'ai';
import {
  canTurn, unsentKickoff, wasSent, needsFreshSession, nextStep, replies, heldBy, type CardRow,
} from '../phantom-backend/looper/logic.js';
import {
  toCodingAgent, toSupervisor, firstLine,
} from '../core/llm/prompts/supervisor/wiring.js';
import {
  SUPERVISOR_MOVES, ENDING_TOOLS, loopSupervisorTools, loopBlockTool,
} from '../core/llm/tools/kanban.js';

const card = (o: Partial<CardRow> = {}): CardRow => ({
  id: 1, seq: 7, title: 'add uptime', status: 'plan', user_story: 'as a dev',
  details: 'd', requirements: [{ key: 'ab12', text: 'works', done: false }],
  blocked_reason: null, auto_plan: null, auto_build: null, archived: false, ...o,
});

const user = (content: string): ModelMessage => ({ role: 'user', content });
const asst = (content: string): ModelMessage => ({ role: 'assistant', content });
const toolTurn = (toolName: string, text?: string): ModelMessage => ({
  role: 'assistant',
  content: [
    ...(text ? [{ type: 'text' as const, text }] : []),
    { type: 'tool-call' as const, toolCallId: 'tc1', toolName, input: {} },
  ],
});

test('canTurn: per-column switches — auto_plan gates plan, auto_build gates in_progress; archived never', () => {
  const both = { plan: true, build: true };
  const neither = { plan: false, build: false };
  assert.equal(canTurn(card(), { plan: true, build: false }), true, 'null inherits the workspace auto_plan for a plan card');
  assert.equal(canTurn(card(), { plan: false, build: true }), false, 'auto_build says nothing about a plan card');
  assert.equal(canTurn(card({ status: 'in_progress' }), { plan: false, build: true }), true, 'null inherits auto_build in in_progress');
  assert.equal(canTurn(card({ status: 'in_progress' }), { plan: true, build: false }), false, 'auto_plan says nothing about an in_progress card');
  assert.equal(canTurn(card({ auto_plan: true }), neither), true, 'the card switch overrides');
  assert.equal(canTurn(card({ auto_plan: false }), both), false, 'both ways');
  assert.equal(canTurn(card({ status: 'in_progress', auto_build: true }), neither), true);
  assert.equal(canTurn(card({ status: 'in_progress', auto_build: false }), both), false);
  assert.equal(canTurn(card({ auto_build: true }), neither), false, "the OTHER column's card switch does not arm it");
  assert.equal(canTurn(card({ status: 'backlog' }), both), false, 'the break IS this predicate');
  assert.equal(canTurn(card({ status: 'done' }), both), false);
  assert.equal(canTurn(card({ archived: true }), both), false);
});

test('the lock label is the WORK, not the loop that started it', () => {
  // A window locked out of a coding session sees what is happening —
  // "supervisor" there was a lie about who was typing, and a sentence about
  // locks is not something you can act on.
  assert.equal(heldBy('coding', 'plan'), 'planning');
  assert.equal(heldBy('coding', 'in_progress'), 'building');
  assert.equal(heldBy('supervisor', 'in_progress'), 'reviewing');
  // One word, no card: the window draws it after a spinner, and its status
  // line already names the card.
  for (const status of ['plan', 'in_progress']) {
    for (const seat of ['coding', 'supervisor'] as const) {
      assert.match(heldBy(seat, status), /^[a-z]+$/, 'one plain word');
    }
  }
});

test('the three kickoffs: fixed first lines, the card JSON appended, plan is read-only', () => {
  const c = card();
  assert.ok(toCodingAgent.planCard(c).startsWith('Plan card 7.\n'));
  assert.ok(toCodingAgent.buildFromPlan(c).startsWith('The plan you produced earlier for card 7 was reviewed and approved'));
  assert.ok(toCodingAgent.buildFromCard(c).startsWith('Build card 7.\n'));
  assert.match(toCodingAgent.planCard(c), /read-only in this phase/);
  assert.ok(!toCodingAgent.buildFromCard(c).toLowerCase().includes('plan'),
    'the unplanned path skips planning language altogether');
  for (const opener of [toCodingAgent.planCard(c), toCodingAgent.buildFromPlan(c), toCodingAgent.buildFromCard(c)]) {
    assert.match(opener, /"requirements"/, 'the card rides every kickoff as JSON');
    assert.match(opener, /"ab12"/, 'requirement keys included — ticks go by key');
  }
});

test('unsentKickoff: the session IS the state — which kickoff is owed', () => {
  const c = card();
  assert.deepEqual(unsentKickoff(c, []), { text: toCodingAgent.planCard(c), planMode: true });
  assert.equal(unsentKickoff(c, [user(toCodingAgent.planCard(c))]), null);
  const planned = [user(toCodingAgent.planCard(c))];
  const ip = card({ status: 'in_progress' });
  assert.deepEqual(unsentKickoff(ip, planned), { text: toCodingAgent.buildFromPlan(ip), planMode: false });
  assert.deepEqual(unsentKickoff(ip, []), { text: toCodingAgent.buildFromCard(ip), planMode: false });
  assert.equal(unsentKickoff(ip, [...planned, user(toCodingAgent.buildFromPlan(ip))]), null);
  assert.equal(unsentKickoff(ip, [user(toCodingAgent.buildFromCard(ip))]), null);
  assert.equal(unsentKickoff(card({ status: 'blocked' }), []), null);
});

test('wasSent matches the frozen first line, not the whole text', () => {
  assert.equal(wasSent([user('Plan card 7.\nanything after')], firstLine.planCard(7)), true);
  assert.equal(wasSent([user('Plan card 17.\n')], firstLine.planCard(7)), false);
  assert.equal(wasSent([asst('Plan card 7.')], firstLine.planCard(7)), false,
    'only USER messages are kickoffs');
});

test('needsFreshSession: entering plan is a new session, always; continuing is not', () => {
  const t0 = new Date('2026-08-26T10:00:00Z');
  const t1 = new Date('2026-08-26T11:00:00Z');
  assert.equal(needsFreshSession('plan', null, null), true, 'no session yet');
  assert.equal(needsFreshSession('plan', t1, t0), false, 'session made after the move: continuing');
  assert.equal(needsFreshSession('plan', t0, t1), true, 're-entered plan after the session: unlink');
  assert.equal(needsFreshSession('plan', t0, null), false, 'born in plan, no transition on record');
  assert.equal(needsFreshSession('in_progress', t0, t1), false, 'only plan entries reset');
});

// ── the step rule ───────────────────────────────────────────────────────────

test('replies: what crosses — non-terminal turn text in order; a terminal turn is silence', () => {
  const msgs: ModelMessage[] = [
    user('go'),
    asst('one'),
    user('more'),
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'a', toolName: 'read_file', input: {} }] } as ModelMessage,
    asst('two'),
    user('again'),
    toolTurn('kanban_card_block', 'I quit'),
  ];
  assert.deepEqual(replies(msgs), ['one', 'two'],
    'an ordinary tool call does not end a turn; the block turn never crosses');
  const empty: ModelMessage[] = [user('go'), { role: 'assistant', content: [
    { type: 'tool-call', toolCallId: 'a', toolName: 'read_file', input: {} }] } as ModelMessage];
  assert.deepEqual(replies(empty), ['(no reply)'],
    'a text-less turn crosses as a placeholder so the two sides never drift');
});

test('nextStep: first supervisor turn — the IMPLANTED plan briefing, then the reply', () => {
  const c = card();
  const kick = toCodingAgent.planCard(c);
  const coder = [user(kick), asst('the plan: do X')];
  const step = nextStep(c, coder, []);
  assert.equal(step?.kind, 'supervisor');
  const append = (step as { append: string[] }).append;
  assert.equal(append.length, 2);
  assert.ok(append[0].startsWith("You are reviewing the coding agent's plan for card 7."),
    'the plan briefing opens the conversation');
  assert.match(append[0], /The card:/, 'the card rides the opening briefing');
  assert.match(append[0], /Its plan follows this format:/, 'the format is in the briefing');
  assert.match(append[0], /\*\*Goal\*\*/, 'the shared PLAN_FORMAT block, verbatim');
  assert.equal(append[1], 'the plan: do X', 'then the reply, verbatim');
});

test('nextStep: the dialogue alternates — copy owed, then delivery owed, then copy again', () => {
  const c = card();
  const kick = toCodingAgent.planCard(c);
  const seeds = [toSupervisor.reviewingPlan(c)];
  // Supervisor already replied (non-terminal): its text is owed to the coder.
  const sup = [...seeds.map(user), user('the plan: do X'), asst('Demand 1: justify Y')];
  const coder = [user(kick), asst('the plan: do X')];
  assert.deepEqual(nextStep(c, coder, sup), { kind: 'deliver', text: 'Demand 1: justify Y' });
  // Delivered + coder replied: only the new reply crosses, no seeds again.
  const coder2 = [...coder, user('Demand 1: justify Y'), asst('Changed: Y justified')];
  assert.deepEqual(nextStep(c, coder2, sup), { kind: 'supervisor', append: ['Changed: Y justified'] });
});

test('nextStep: a terminal turn is silence on either side — the card re-entering owes the return message', () => {
  const c = card({ status: 'in_progress', resolution: 'use the staging DB' });
  const kick = toCodingAgent.buildFromCard(c);
  const seeds = [toSupervisor.reviewingWork(c, { planned: false })];
  // The supervisor ended the last run with a move: its final words never
  // cross; a human sent the card back — the coder gets the return message.
  const supEnded = [...seeds.map(user), user('built it'), toolTurn('kanban_card_move', 'Verified, done.')];
  const coder = [user(kick), asst('built it')];
  const step = nextStep(c, coder, supEnded);
  assert.equal(step?.kind, 'return');
  const text = (step as { text: string }).text;
  assert.ok(text.startsWith('Card 7 is back to you.'), 'frozen first line');
  assert.match(text, /use the staging DB/, "the builder's answer rides along");
  // The coder ended the run with a block: its terminal turn never crosses
  // either — same re-entry, and no answer means no answer line.
  const c2 = card({ status: 'in_progress', resolution: null });
  const coderBlocked = [...coder, user('go on'), toolTurn('kanban_card_block', 'cannot work as written')];
  const sup2 = [...seeds.map(user), user('built it'), asst('go on')];
  const step2 = nextStep(c2, coderBlocked, sup2);
  assert.equal(step2?.kind, 'return');
  assert.doesNotMatch((step2 as { text: string }).text, /builder's answer/, 'the answer line vanishes when empty');
});

test('nextStep: phase two seeds the work briefing WITHOUT the card — it already opened the conversation', () => {
  const c = card({ status: 'in_progress',
    requirements: [{ key: 'ab12', text: 'works', done: true }] });   // the card changed since the plan kickoff
  const planKickAsSent = toCodingAgent.planCard(card());             // sent when the requirement was NOT done
  const execKick = toCodingAgent.buildFromPlan(c);
  const seeds = [toSupervisor.reviewingPlan(card())];
  const sup = [...seeds.map(user), user('the plan'), asst('Approved.')];
  const coder = [user(planKickAsSent), asst('the plan'), user('Approved.'),
    user(execKick), asst('built it, report attached')];
  const step = nextStep(c, coder, sup);
  assert.equal(step?.kind, 'supervisor');
  const append = (step as { append: string[] }).append;
  assert.equal(append.length, 2);
  assert.ok(append[0].startsWith("You are reviewing the coding agent's work on card 7."),
    'the work briefing lands when the build phase starts');
  assert.doesNotMatch(append[0], /The card:/, 'the card never repeats — it rode the plan briefing');
  assert.match(append[0], /Its completion report follows this format:/, 'the format is in the briefing');
  assert.match(append[0], /\*\*What shipped\*\*/, 'the shared REPORT_FORMAT block, verbatim');
  assert.equal(append[1], 'built it, report attached', 'then the report, verbatim');
  // Briefing landed: the next round copies replies alone.
  const sup2 = [...sup, ...append.map(user), asst('Fix demand 1')];
  const coder2 = [...coder, user('Fix demand 1'), asst('fixed')];
  assert.deepEqual(nextStep(c, coder2, sup2), { kind: 'supervisor', append: ['fixed'] },
    'each briefing is seeded once');
});

test('nextStep: an empty coder conversation owes a kickoff, not a step', () => {
  assert.equal(nextStep(card(), [], []), null);
});

test('nextStep: ordered matching keeps identical texts honest', () => {
  const c = card({ status: 'in_progress' });
  const kick = toCodingAgent.buildFromCard(c);
  const seeds = [toSupervisor.reviewingWork(c, { planned: false })];
  // The coder said the same thing twice; only one copy landed so far.
  const coder = [user(kick), asst('done'), user('prove it'), asst('done')];
  const sup = [...seeds.map(user), user('done'), asst('prove it')];
  const step = nextStep(c, coder, sup);
  assert.deepEqual(step, { kind: 'supervisor', append: ['done'] },
    'the second identical reply still counts as unported');
});

// ── the loop's card-bound tools ─────────────────────────────────────────────

test('the run-ending tools: per-column verdicts, vital descriptions, bound to THE card', () => {
  const cfg = { baseUrl: 'http://x', apiKey: 'k', workspaceId: 'w', cardId: 1, seq: 7 };
  assert.deepEqual([...SUPERVISOR_MOVES.plan], ['in_progress', 'blocked']);
  assert.deepEqual([...SUPERVISOR_MOVES.in_progress], ['done', 'blocked']);
  assert.deepEqual([...ENDING_TOOLS], ['kanban_card_move', 'kanban_card_block']);

  const desc = (t: Record<string, Tool>, n: string) => String((t[n] as { description: string }).description);
  const inputKeys = (t: Record<string, Tool>, n: string) =>
    Object.keys((t[n] as { inputSchema: { shape: Record<string, unknown> } }).inputSchema.shape);

  const plan = loopSupervisorTools(cfg, 'plan');
  assert.deepEqual(Object.keys(plan), ['kanban_card_move', 'kanban_card_items']);
  assert.match(desc(plan, 'kanban_card_move'), /THIS ENDS THE RUN/);
  assert.match(desc(plan, 'kanban_card_move'), /plan verified and ready to build/);
  assert.doesNotMatch(desc(plan, 'kanban_card_move'), /EVERY requirement/, 'plan column never talks about done');
  const ip = loopSupervisorTools(cfg, 'in_progress');
  assert.match(desc(ip, 'kanban_card_move'), /verified EVERY requirement/);
  assert.deepEqual(inputKeys(ip, 'kanban_card_move'), ['status', 'reason'],
    'no card input — bound at build time');
  assert.deepEqual(inputKeys(ip, 'kanban_card_items'), ['ops'], 'items bound to the card too');

  const block = loopBlockTool(cfg);
  assert.deepEqual(Object.keys(block), ['kanban_card_block'], "the coder's ONE board power");
  assert.match(desc(block, 'kanban_card_block'), /THIS ENDS THE RUN/);
  assert.deepEqual(inputKeys(block, 'kanban_card_block'), ['reason']);
});
