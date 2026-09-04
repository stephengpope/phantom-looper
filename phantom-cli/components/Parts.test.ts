// The tool row's two rules: summarizeOutput (WHAT to show) and clipRows (HOW
// MUCH — rendered rows). The cases that cost time once: an image read fell
// through to the JSON.stringify fallback and printed megabytes of base64, and
// a line cap bounded nothing when the payload was one 100 KB line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOutput, clipRows } from './Parts.js';

test('image read summarizes to type and size, never the base64', () => {
  const base64 = 'A'.repeat(300_000);
  const out = summarizeOutput({ ok: true, data: { image: { media_type: 'image/png', base64, bytes: 245_760 } } });
  assert.equal(out, 'image/png · 240KB');
});

test('one-line giant output is cut by the byte guard, tail kept', () => {
  const out = summarizeOutput({ ok: true, data: `${'x'.repeat(100_000)}END` });
  assert.ok(out !== null && out.length < 4_100, `expected a cut, got ${out?.length} chars`);
  assert.ok(out!.startsWith('… (98KB)'));
  assert.ok(out!.endsWith('END'), 'the tail is what survives — errors live at the end');
});

test('bash output reaches the view whole; the view is what bounds height', () => {
  const stdout = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const out = summarizeOutput({ ok: true, data: { stdout, exit_code: 0 } });
  assert.ok(out!.includes('line 0') && out!.includes('line 19'));
});

// clipRows is the ONE height rule: rendered rows, not logical lines.
test('clipRows keeps the tail and counts the lines it dropped', () => {
  const { lines, omitted } = clipRows(Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'), 80, 5);
  assert.deepEqual(lines, ['line 15', 'line 16', 'line 17', 'line 18', 'line 19']);
  assert.equal(omitted, 15);
});

test('clipRows keeps the head of a command, allowing for the name beside it', () => {
  const { lines, omitted } = clipRows("python3 - <<'PY'\na\nb\nc\nPY", 80, 3, 'head', 74);
  assert.deepEqual(lines, ["python3 - <<'PY'", 'a', 'b']);
  assert.equal(omitted, 2);
});

test('clipRows bounds ONE long line by rows, not by its line count', () => {
  const { lines } = clipRows('x'.repeat(5_000), 80, 5);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length <= 5 * 80, `one line still fits the budget, got ${lines[0].length} chars`);
  assert.ok(lines[0].startsWith('…'), 'and says it was cut');
});

test('text read stays a line count', () => {
  const out = summarizeOutput({ ok: true, data: { content: 'a\nb\nc' } });
  assert.equal(out, '3 lines');
});

test('edit summarizes to replacements, strategy and the diff\'s +/− counts, never the diff', () => {
  const diff = '--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n a\n-old\n+new\n+more\n c\n';
  assert.equal(summarizeOutput({ ok: true, data: { replacements: 1, strategy: 'exact', diff } }, 'edit'),
    '1 replacement, exact · +2 −1');
  const many = summarizeOutput({ ok: true, data: { edits: [
    { replacements: 2, strategy: 'exact' }, { replacements: 1, strategy: 'whitespace' },
  ], diff } }, 'edit');
  assert.equal(many, '3 replacements, exact/whitespace · +2 −1');
});

test('write summarizes to the size written; web search and fetch name their items', () => {
  assert.equal(summarizeOutput({ ok: true, data: { path: '/workspace/repo/a.ts', bytes: 1536 } }, 'write'), '2KB written');
  assert.equal(summarizeOutput({ ok: true, data: [{}, {}, {}] }, 'web_search'), '3 results');
  assert.equal(summarizeOutput({ ok: true, data: [{}] }, 'web_fetch'), '1 page');
});
