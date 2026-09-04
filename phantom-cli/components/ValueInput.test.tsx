// The model field's combobox: one field that filters the catalog as you type
// and accepts a value outside it. (Closed `choices` and plain text paths are
// exercised elsewhere; this covers the combobox.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { ValueInput, type EditSpec } from './ValueInput.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = '\x1b[B';

const modelSpec: EditSpec = {
  title: 'model',
  type: 'string',
  current: 'claude-opus-5',
  suggestions: ['claude-fable-5', 'claude-opus-5', 'claude-haiku-4-5'],
  suggestionLabels: {
    'claude-fable-5': 'Claude Fable 5',
    'claude-opus-5': 'Claude Opus 5',
    'claude-haiku-4-5': 'Claude Haiku 4.5',
  },
  note: 'anthropic models from models.dev',
};

test('opens as one field: filter line, pretty labels, ids as detail, current marked', async () => {
  const { lastFrame } = render(<ValueInput spec={modelSpec} onSubmit={() => {}} onCancel={() => {}} />);
  await sleep(40);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /filter or type an id/, 'a single filter/entry field');
  assert.match(f, /Claude Fable 5/, 'pretty label shown');
  assert.match(f, /claude-opus-5.*current/, 'current model marked');
});

test('typing filters the list live', async () => {
  const { lastFrame, stdin } = render(<ValueInput spec={modelSpec} onSubmit={() => {}} onCancel={() => {}} />);
  await sleep(40);
  stdin.write('haiku');
  await sleep(40);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /Claude Haiku 4\.5/);
  assert.doesNotMatch(f, /Claude Fable 5/, 'non-matching rows are filtered out');
  assert.doesNotMatch(f, /Claude Opus 5/);
});

test('enter takes the highlighted suggestion (filter then enter)', async () => {
  let got: unknown = 'UNSET';
  const { stdin } = render(<ValueInput spec={modelSpec} onSubmit={(v) => { got = v; }} onCancel={() => {}} />);
  await sleep(40);
  stdin.write('fable');
  await sleep(40);
  stdin.write('\r');
  await sleep(40);
  assert.equal(got, 'claude-fable-5', 'submits the raw id, not the label');
});

test('a typed id that is not in the catalog is offered and submitted from the same field', async () => {
  let got: unknown = 'UNSET';
  const { lastFrame, stdin } = render(<ValueInput spec={modelSpec} onSubmit={(v) => { got = v; }} onCancel={() => {}} />);
  await sleep(40);
  stdin.write('my-private-model');
  await sleep(40);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /use .*my-private-model/, 'a "use …" row appears for the typed value');
  // Only the custom row remains, so it is highlighted; enter submits it.
  stdin.write('\r');
  await sleep(40);
  assert.equal(got, 'my-private-model');
});

test('arrows move the highlight; enter uses the moved-to row', async () => {
  let got: unknown = 'UNSET';
  const { stdin } = render(<ValueInput spec={modelSpec} onSubmit={(v) => { got = v; }} onCancel={() => {}} />);
  await sleep(40);
  stdin.write(DOWN); // fable -> opus
  await sleep(40);
  stdin.write('\r');
  await sleep(40);
  assert.equal(got, 'claude-opus-5');
});

test('no suggestions (e.g. openai-compatible) is a plain text field, not a combobox', async () => {
  const spec: EditSpec = { title: 'model', type: 'string', current: 'local-thing' };
  const { lastFrame } = render(<ValueInput spec={spec} onSubmit={() => {}} onCancel={() => {}} />);
  await sleep(40);
  const f = strip(lastFrame() ?? '');
  assert.doesNotMatch(f, /filter or type an id/);
  assert.match(f, /\[empty\] clears it/, 'the plain text-field footer');
});
