// paste.ts: a big paste becomes a chip in the prompt and its text lives in
// the store; submit swaps it back. The tests pin the contract both Claude
// Code and opencode learned the hard way — the literal chip must never
// reach the model, and a chip whose text is gone is stripped, not sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PasteStore, chipAtEnd } from './paste.js';

const big = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');

test('a paste of 3+ lines collapses into a numbered chip', () => {
  const store = new PasteStore();
  assert.equal(store.collapse(big), '[Pasted #1 ~12 lines]');
  assert.equal(store.collapse('a\nb\nc'), '[Pasted #2 ~3 lines]');
});

test('a long single-line paste collapses too; short pastes stay text', () => {
  const store = new PasteStore();
  assert.equal(store.collapse('x'.repeat(200)), '[Pasted #1 ~1 lines]');
  assert.equal(store.collapse('just a sentence'), null);
  assert.equal(store.collapse('two\nlines'), null);
});

test('expand swaps each chip for its text, in place, several in one line', () => {
  const store = new PasteStore();
  const c1 = store.collapse(big)!;
  const c2 = store.collapse('x'.repeat(200))!;
  const { text, missing } = store.expand(`see ${c1} and ${c2} please`);
  assert.equal(text, `see ${big} and ${'x'.repeat(200)} please`);
  assert.deepEqual(missing, []);
});

test('a chip with no stored text is stripped and reported, never sent raw', () => {
  const store = new PasteStore();
  const { text, missing } = store.expand('look [Pasted #9 ~5 lines] here');
  assert.equal(text, 'look  here');
  assert.deepEqual(missing, [9]);
});

test('text without chips passes through untouched', () => {
  const store = new PasteStore();
  assert.deepEqual(store.expand('hello world'), { text: 'hello world', missing: [] });
  // Something that merely LOOKS chip-adjacent is not a chip.
  assert.deepEqual(store.expand('[Pasted #1 ~2 line]'), { text: '[Pasted #1 ~2 line]', missing: [] });
});

test('chipAtEnd: a backspace target only at the very end of the text', () => {
  assert.equal(chipAtEnd('check [Pasted #1 ~12 lines]'), '[Pasted #1 ~12 lines]'.length);
  assert.equal(chipAtEnd('check [Pasted #1 ~12 lines] more'), 0);
  assert.equal(chipAtEnd('[Pasted #1 ~12 lines'), 0);
  assert.equal(chipAtEnd(''), 0);
});
