import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { SecretEditor } from './SecretEditor.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TARGETS = [
  { id: null, label: 'global — every workspace' },
  { id: 'w1', label: 'acme only' },
];

test('every label row keeps a gutter before its value — Description included', async () => {
  const { lastFrame } = render(
    <SecretEditor mode="new" targets={TARGETS} onSave={() => {}} onCancel={() => {}} />,
  );
  await sleep(40);
  const f = strip(lastFrame() ?? '');
  // "Description" is the widest label (11 + the 2-cell marker = 13): at
  // width 13 it sat flush against the placeholder. The gutter lives INSIDE
  // the column width (table.ts's rule), so at least two spaces must separate
  // every label from its value.
  assert.match(f, /Description {2,}\S/, 'Description row has a gutter before the value');
  assert.match(f, /Name {2,}\S/);
  assert.match(f, /Value {2,}\S/);
  assert.doesNotMatch(f, /Description\S/, 'the label never sits flush against the text');
  // Every value starts in the same column — the label box is one fixed width.
  const rows = f.split('\n');
  const startOf = (text: string) => rows.find((r) => r.includes(text))!.indexOf(text);
  const starts = [
    startOf('lowercase_with_underscores'),
    startOf('one line the agent reads'),
    startOf('the secret itself'),
  ];
  assert.equal(new Set(starts).size, 1, `value columns align (starts: ${starts.join(',')})`);
});
