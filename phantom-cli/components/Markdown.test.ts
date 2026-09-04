// renderMarkdown: marked-terminal drops inline markdown inside tight list
// items (its text renderer returns the raw source), so `- item **one**`
// printed the asterisks. Runs under FORCE_COLOR so bold is an escape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './Markdown.js';

const BOLD = '\x1b[1m';

test('bold and code inside a tight list item render', () => {
  const out = renderMarkdown('- item **one**\n- item `two`', 60);
  assert.ok(!out.includes('**'), out);
  assert.ok(!out.includes('`'), out);
  assert.ok(out.includes(`${BOLD}one`), out);
});

test('bold in a paragraph still renders', () => {
  const out = renderMarkdown('Hello **bold**', 60);
  assert.ok(out.includes(`${BOLD}bold`), out);
});

const plain = (s: string) => s.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));

test('an ordered list numbers from its start, nested items untouched', () => {
  assert.deepEqual(plain(renderMarkdown('2. second\n3. third\n   1. nested', 60)),
    ['  2. second', '  3. third', '    1. nested']);
});

test('a nested list neither miscounts the outer list nor leaves a blank row', () => {
  assert.deepEqual(plain(renderMarkdown('1. a\n2. b\n   - sub\n   - sub2\n3. c', 60)),
    ['  1. a', '  2. b', '    * sub', '    * sub2', '  3. c']);
  assert.deepEqual(plain(renderMarkdown('- a\n  - sub\n  - sub2\n- b', 60)),
    ['  * a', '    * sub', '    * sub2', '  * b']);
});

test('a list followed by a paragraph keeps its block gap', () => {
  assert.deepEqual(plain(renderMarkdown('- a\n- b\n\nAfter.', 60)), ['  * a', '  * b', '', 'After.']);
});
