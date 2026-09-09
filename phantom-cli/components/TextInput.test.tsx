// TextInput's paste-chip behavior: a big paste lands in the box as a chip
// (its text in the PasteStore), and a backspace just after a chip removes
// the chip whole. Asserted on the VALUE the box emits — what the code does,
// never what the screen looks like (test/CLAUDE.md's one rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { TextInput } from './TextInput.js';
import { PasteStore } from '../paste.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const big = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');

function box(pastes?: PasteStore) {
  const seen: string[] = [];
  function Harness() {
    const [value, setValue] = React.useState('');
    return React.createElement(TextInput, {
      value, onChange: (v: string) => { seen.push(v); setValue(v); }, pastes,
    });
  }
  const app = render(React.createElement(Harness));
  return { app, seen };
}

test('a big paste lands as a chip, its text in the store', async () => {
  const pastes = new PasteStore();
  const { app, seen } = box(pastes);
  app.stdin.write(big);
  await sleep(50);
  assert.equal(seen.at(-1), '[Pasted #1 ~12 lines]');
  assert.deepEqual(pastes.expand(seen.at(-1)!), { text: big, missing: [] });
  app.unmount();
});

test('a short paste lands as plain text', async () => {
  const pastes = new PasteStore();
  const { app, seen } = box(pastes);
  app.stdin.write('short text');
  await sleep(50);
  assert.equal(seen.at(-1), 'short text');
  app.unmount();
});

test('backspace removes a chip whole, then resumes a character at a time', async () => {
  const pastes = new PasteStore();
  const { app, seen } = box(pastes);
  app.stdin.write('check ');
  await sleep(50);
  app.stdin.write(big);
  await sleep(50);
  assert.equal(seen.at(-1), 'check [Pasted #1 ~12 lines]');
  app.stdin.write('\u007F');
  await sleep(50);
  assert.equal(seen.at(-1), 'check ');
  app.stdin.write('\u007F');
  await sleep(50);
  assert.equal(seen.at(-1), 'check');
  app.unmount();
});
