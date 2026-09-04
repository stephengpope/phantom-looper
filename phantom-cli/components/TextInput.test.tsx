// The typing area's editor. The reason it exists is the first test here:
// ink-text-input inserted every key it did not recognise, so ctrl+o typed an
// `o` and no ctrl chord could be used for anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import { TextInput } from './TextInput.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const LEFT = '\x1b[D', RIGHT = '\x1b[C', UP = '\x1b[A', DOWN = '\x1b[B';
const BACKSPACE = '\x7f', TAB = '\t', ESC = '\x1b';

function Harness({ onSubmit }: { onSubmit?: (v: string) => void } = {}) {
  const [value, setValue] = useState('');
  return <TextInput value={value} onChange={setValue} onSubmit={onSubmit} placeholder="type a message…" />;
}

const box = (frame: string) => strip(frame).trim();

test('a chord is not text — ctrl and meta never reach the line', async () => {
  const r = render(<Harness />);
  try {
    await sleep(20);
    r.stdin.write('\x0f');                     // ctrl+o
    r.stdin.write('\x07');                     // ctrl+g
    r.stdin.write('\x01');                     // ctrl+a
    await sleep(60);
    assert.match(box(r.lastFrame() ?? ''), /type a message/,
      'the line is still empty — this is the whole reason the component exists');
    r.stdin.write('ok'); await sleep(40);
    assert.equal(box(r.lastFrame() ?? ''), 'ok', 'and ordinary letters still type');
  } finally { r.unmount(); }
});

test('keys the handlers above own are left alone', async () => {
  const r = render(<Harness />);
  try {
    await sleep(20);
    r.stdin.write('hi'); await sleep(40);
    for (const k of [UP, DOWN, TAB, ESC, '\x1b[5~']) { r.stdin.write(k); await sleep(20); }
    assert.equal(box(r.lastFrame() ?? ''), 'hi',
      'arrows up/down, tab, esc and pageUp are for the app, not the line');
  } finally { r.unmount(); }
});

test('typing, moving and deleting land where the cursor is', async () => {
  const r = render(<Harness />);
  try {
    await sleep(20);
    r.stdin.write('hello'); await sleep(40);
    r.stdin.write(LEFT); r.stdin.write(LEFT); await sleep(40);
    r.stdin.write('X'); await sleep(40);
    assert.equal(box(r.lastFrame() ?? ''), 'helXlo', 'inserted at the cursor, not the end');
    r.stdin.write(BACKSPACE); await sleep(40);
    assert.equal(box(r.lastFrame() ?? ''), 'hello', 'and backspace takes what is behind it');
    r.stdin.write(RIGHT); r.stdin.write(RIGHT); await sleep(40);
    r.stdin.write('!'); await sleep(40);
    assert.equal(box(r.lastFrame() ?? ''), 'hello!');
  } finally { r.unmount(); }
});

test('a value set from outside puts the cursor at the end of it', async () => {
  // What tab completion and ↑-through-history both need: the caller replaces
  // the whole line, and the next keystroke must append rather than land in the
  // middle of it.
  function Outside() {
    const [value, setValue] = useState('');
    return (
      <>
        <TextInput value={value} onChange={setValue} placeholder="…" />
        <Replace onReplace={() => setValue('/settings ')} />
      </>
    );
  }
  function Replace({ onReplace }: { onReplace: () => void }) {
    const [done, setDone] = useState(false);
    if (!done) { setTimeout(() => { onReplace(); setDone(true); }, 30); }
    return null;
  }
  const r = render(<Outside />);
  try {
    await sleep(120);
    r.stdin.write('x'); await sleep(60);
    assert.equal(box(r.lastFrame() ?? ''), '/settings x',
      'appended — a cursor left at 0 would have produced "x/settings "');
  } finally { r.unmount(); }
});

test('enter submits what is on the line, and does not type a newline', async () => {
  let got: string | undefined;
  const r = render(<Harness onSubmit={(v) => { got = v; }} />);
  try {
    await sleep(20);
    r.stdin.write('do the thing'); await sleep(40);
    r.stdin.write('\r'); await sleep(40);
    assert.equal(got, 'do the thing');
    assert.equal(box(r.lastFrame() ?? ''), 'do the thing', 'submitting does not clear it — the caller does');
  } finally { r.unmount(); }
});

test('a paste arrives as one input and goes in whole', async () => {
  const r = render(<Harness />);
  try {
    await sleep(20);
    r.stdin.write('read src/index.ts and tell me what boots first'); await sleep(60);
    assert.equal(box(r.lastFrame() ?? ''), 'read src/index.ts and tell me what boots first');
  } finally { r.unmount(); }
});

test('an unfocused line shows its text and swallows nothing', async () => {
  const r = render(<TextInput value="held" onChange={() => {}} focus={false} placeholder="…" />);
  try {
    await sleep(20);
    r.stdin.write('more'); await sleep(40);
    assert.equal(box(r.lastFrame() ?? ''), 'held', 'a turn is running; the keys are not ours');
  } finally { r.unmount(); }
});
