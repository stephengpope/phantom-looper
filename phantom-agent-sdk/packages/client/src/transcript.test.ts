// lastUsage: the context meter's one source. It reads the LAST usage line
// — never a delta — so tool-result lines after it change nothing, and an
// empty record answers null rather than 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastUsage, messageLine, usageLine, userMessage, assistantMessage, type TranscriptLine } from './transcript.js';

const call = (input: number, cacheRead = 0) =>
  usageLine({ provider: 'anthropic', model: 'm', input, output: 10, cacheRead, cacheWrite: 0 });

test('null before the first model call', () => {
  assert.equal(lastUsage([]), null);
  assert.equal(lastUsage([messageLine(userMessage('hi'))]), null);
});

test('the last call, not the sum', () => {
  const lines: TranscriptLine[] = [
    messageLine(userMessage('hi')), messageLine(assistantMessage('a')), call(12_000),
    messageLine(userMessage('more')), messageLine(assistantMessage('b')), call(25_000),
    messageLine(assistantMessage('c')), call(48_000, 40_000),
  ];
  assert.deepEqual(lastUsage(lines), { input: 48_000, output: 10, cacheRead: 40_000, cacheWrite: 0 });
});

test('tool results after the call do not move it', () => {
  const lines: TranscriptLine[] = [messageLine(assistantMessage('a')), call(48_000)];
  const before = lastUsage(lines);
  lines.push(messageLine({ role: 'tool', content: [] }));
  lines.push(messageLine({ role: 'tool', content: [] }));
  assert.deepEqual(lastUsage(lines), before);
});
