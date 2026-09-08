import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnAgeColor, TURN_LONG_MS, TURN_STUCK_MS } from './turnAge.js';

test('a turn ages through the same three colours everywhere it is drawn', () => {
  const now = Date.now();
  assert.equal(turnAgeColor(now), 'magenta', 'a turn that just started is normal');
  assert.equal(turnAgeColor(now - (TURN_LONG_MS - 1_000)), 'magenta', 'still normal a moment before the step');
  assert.equal(turnAgeColor(now - TURN_LONG_MS), 'yellow', 'ten minutes is worth a look');
  assert.equal(turnAgeColor(now - (TURN_STUCK_MS - 1_000)), 'yellow', 'still a look a moment before the step');
  assert.equal(turnAgeColor(now - TURN_STUCK_MS), 'red', 'half an hour is probably wrong');
  assert.equal(turnAgeColor(now - 6 * TURN_STUCK_MS), 'red', 'and stays wrong');
});

test('an unknown age is never a warning', () => {
  // Every spinner was magenta before this rule existed, and a view that cannot
  // say when its turn began must keep reading that way — a missing start time
  // is ignorance, not evidence of a stuck turn. The session list and the
  // toolbar both hand this an optional value.
  assert.equal(turnAgeColor(undefined), 'magenta');
  assert.equal(turnAgeColor(null), 'magenta');
  assert.equal(turnAgeColor(0), 'magenta', 'the store seeds startedAt at 0');
});

test('the steps are ordered, so a colour can only ever get more urgent', () => {
  assert.ok(TURN_LONG_MS < TURN_STUCK_MS);
});
