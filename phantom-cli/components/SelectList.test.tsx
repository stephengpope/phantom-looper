import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { SelectList } from './SelectList.js';
import { BudgetContext } from './Screen.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = '\x1b[B', UP = '\x1b[A', ESC = '\x1b';

const SETTINGS = [
  { value: 'h1', label: 'model', heading: true },
  { value: 'provider', label: 'provider', detail: 'anthropic        file', hint: 'Which model this TUI talks to.' },
  { value: 'model', label: 'model', detail: 'claude-opus-5    file' },
  { value: 'reasoning', label: 'reasoning', detail: 'medium           default' },
  { value: 'h2', label: 'server', heading: true },
  { value: 'url', label: 'url', detail: 'localhost:8080   default' },
  { value: 'key', label: 'api key', detail: '••••3f9a         file' },
];

test('renders headings, details, cursor', async () => {
  const { lastFrame } = render(<SelectList choices={SETTINGS} onSelect={()=>{}} />);
  await sleep(40);
  console.log(strip(lastFrame() ?? ''));
  const f = strip(lastFrame() ?? '');
  assert.match(f, /❯ provider/, 'cursor skips the heading and lands on first real row');
  assert.match(f, /anthropic/);
});

test('a busy row draws the spinner ahead of its label, down the left edge', async () => {
  const rows = [
    { value: 'a', label: 'widgets', detail: '"fix the tests"  working…', busy: true },
    { value: 'b', label: 'knack', detail: '"add a column"  2h ago' },
  ];
  const { lastFrame } = render(<SelectList choices={rows} onSelect={()=>{}} />);
  await sleep(40);
  const f = strip(lastFrame() ?? '');
  console.log(f);
  const [busyRow, idleRow] = f.split('\n');
  // ink-spinner's dots are braille cells; the marker slot sits BEFORE the
  // label so activity reads down the left edge.
  assert.match(busyRow, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] widgets/, 'busy row animates');
  assert.doesNotMatch(idleRow, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, 'idle row does not');
});

test('arrows skip headings, wrap, and enter selects', async () => {
  let picked = '';
  const { lastFrame, stdin } = render(<SelectList choices={SETTINGS} onSelect={(v)=>{picked=String(v)}} />);
  await sleep(40);
  stdin.write(DOWN); stdin.write(DOWN); await sleep(40);  // provider -> model -> reasoning
  stdin.write(DOWN); await sleep(40);                     // must SKIP 'server' heading -> url
  const f = strip(lastFrame() ?? '');
  console.log('after 3 downs:\n' + f);
  assert.match(f, /❯ url/, 'heading must not be selectable');
  stdin.write('\r'); await sleep(40);
  assert.equal(picked, 'url');
});

test('caps rows to the page budget and reports the remainder', async () => {
  const many = Array.from({length: 27}, (_,i) => ({ value: i, label: `setting_${i}` }));
  // Budget 11 leaves a 6-row window after the list's own fixed rows.
  const { lastFrame } = render(
    <BudgetContext.Provider value={11}>
      <SelectList choices={many} onSelect={()=>{}} />
    </BudgetContext.Provider>);
  await sleep(40);
  const f = strip(lastFrame() ?? '');
  const lines = f.split('\n').filter(l=>l.trim());
  console.log(f);
  assert.ok(lines.length <= 7, `expected <=7 lines got ${lines.length}`);
  assert.match(f, /↓ 21 more/);
});

test('esc cancels', async () => {
  let cancelled = false;
  const { stdin } = render(<SelectList choices={SETTINGS} onSelect={()=>{}} onCancel={()=>{cancelled=true}} />);
  await sleep(40);
  stdin.write(ESC); await sleep(50);
  assert.ok(cancelled);
});

test('up from first wraps to last', async () => {
  const { lastFrame, stdin } = render(<SelectList choices={SETTINGS} onSelect={()=>{}} />);
  await sleep(40);
  stdin.write(UP); await sleep(50);
  const f = strip(lastFrame() ?? '');
  console.log('after UP from top:\n' + f);
  assert.match(f, /❯ api key/);
});

test('the frame keeps ONE height whatever hint is highlighted', async () => {
  // The hint block used to reserve 3 rows as a MINIMUM: a long hint grew it
  // and shifted the footer and prompt — the up-down flicker. It is exactly
  // HINT_ROWS now; a longer hint is cut, an absent one leaves blank rows.
  const rows = [
    { value: 'a', label: 'short', hint: 'One line.' },
    { value: 'b', label: 'long', hint: Array.from({ length: 12 }, () => 'many words that wrap and wrap across the fixed measure').join(' ') },
    { value: 'c', label: 'none' },
  ];
  const { lastFrame, stdin } = render(<SelectList choices={rows} onSelect={()=>{}} />);
  await sleep(40);
  const height = () => (lastFrame() ?? '').split('\n').length;
  const first = height();
  stdin.write(DOWN); await sleep(40);
  assert.equal(height(), first, 'a long hint must not grow the frame');
  stdin.write(DOWN); await sleep(40);
  assert.equal(height(), first, 'no hint must not shrink the frame');
});

test('a long label keeps its row on one line', async () => {
  // A fixed 22-wide label column wrapped anything longer — the label on one
  // line, its value orphaned on the next — which reads as a broken list.
  const { lastFrame } = render(
    <SelectList
      choices={[
        { value: 'a', label: 'agent_git_credentials', detail: 'no        built in' },
        { value: 'b', label: 'x', detail: 'yes       built in' },
      ]}
      onSelect={() => {}}
    />);
  await sleep(30);
  const lines = strip(lastFrame() ?? '').split('\n').filter((l) => l.trim());
  assert.match(lines[0], /agent_git_credentials\s+no\s+built in/, 'label and value share a line');
  assert.equal(lines.length, 2, 'two choices, two lines');
  // And the column tracks the content, so a list of short labels stays tight.
  const { lastFrame: tight } = render(
    <SelectList choices={[{ value: 'a', label: 'name', detail: 'Widgets' }]} onSelect={() => {}} />);
  await sleep(30);
  assert.match(strip(tight() ?? ''), /name\s{2,12}Widgets/, 'short labels do not get a 34-wide gutter');
});

test('onNearEnd fires as the cursor enters the last NEAR_END rows, not before', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ value: i, label: `session_${i}` }));
  let fired = 0;
  const { stdin } = render(
    <BudgetContext.Provider value={40}>
      <SelectList choices={rows} onSelect={()=>{}} onNearEnd={() => { fired++; }} />
    </BudgetContext.Provider>);
  await sleep(40);
  // Rows 1..19 are all more than NEAR_END (10) from the end of 30.
  for (let i = 0; i < 19; i++) stdin.write(DOWN);
  await sleep(40);
  assert.equal(fired, 0, 'quiet until the cursor nears the bottom');
  stdin.write(DOWN); await sleep(40);     // row 20 = index 20 >= 30 - 10
  assert.equal(fired, 1, 'the step into the zone fires it');
  stdin.write(DOWN); await sleep(40);
  assert.equal(fired, 2, 'each further step fires again — the caller de-dupes');
});

test('a marked column draws a colored • ahead of its text, the text still dim', async () => {
  const rows = [
    { value: 'a', label: 'PHA', columns: [{ text: 'not pushed', width: 14, mark: 'red' }, { text: 'manual' }] },
    { value: 'b', label: 'PHA', columns: [{ text: 'merged', width: 14, mark: 'green' }, { text: 'manual' }] },
    { value: 'c', label: 'PHA', columns: [{ text: '·', width: 14 }, { text: 'manual' }] },
  ];
  const { lastFrame } = render(<SelectList choices={rows} onSelect={()=>{}} />);
  await sleep(40);
  const raw = lastFrame() ?? '';
  const [red, green, none] = strip(raw).split('\n');
  console.log(strip(raw));
  // The mark sits at the head of the cell, one space, then the words — the
  // words start at the same column whatever the color.
  assert.match(red, /PHA\s+• not pushed\s+manual/);
  assert.match(green, /PHA\s+• merged\s+manual/);
  assert.equal(red.indexOf('not pushed'), green.indexOf('merged'), 'marked words align');
  assert.doesNotMatch(none, /•/, 'an unmarked cell draws no •');
  assert.equal(none.indexOf('·'), red.indexOf('•'), 'the blank-fact dot sits where a mark would');
  // The color is the mark's own (FORCE_COLOR=3 in the suite): SGR 31 red,
  // 32 green — and NOT wrapped in the column's dim (SGR 2), which is what
  // nesting the mark inside the dim Text would have produced.
  assert.match(raw, /\x1b\[31m•/, 'red mark');
  assert.match(raw, /\x1b\[32m•/, 'green mark');
  assert.doesNotMatch(raw, /\x1b\[2m[^\n]*•/, 'the mark is never dimmed');
});

test('columns never touch: an overflowing row loses its tail, every gutter survives', async () => {
  // Fixed widths that total past the fake terminal's 100 cols, every cell
  // longer than its column. The law under test: a gutter is paddingRight
  // inside a fixed flexShrink=0 box, so overflow truncates the free tail —
  // it can never squeeze a gap shut (spare-space gutters were the recurring
  // columns-flush-together bug). A MARKED column obeys the same law: the
  // mark is a pinned two-cell box, so the text beside it truncates into the
  // gutter and the mark is never squeezed.
  const rows = Array.from({ length: 4 }, (_, i) => ({
    value: i,
    label: `an-extremely-long-label-that-hits-the-thirty-two-cap-${i}`,
    columns: [
      { text: 'a-long-first-column-value-that-truncates', width: 30, mark: 'red' },
      { text: 'a-long-second-column-value-that-truncates-too', width: 34 },
      { text: 'tail' },
    ],
  }));
  const { lastFrame } = render(<SelectList choices={rows} onSelect={()=>{}} />);
  await sleep(40);
  const f = strip(lastFrame() ?? '');
  console.log(f);
  for (const line of f.split('\n')) {
    assert.doesNotMatch(line, /…\S/,
      `a truncated cell sits flush against the next column: ${JSON.stringify(line)}`);
  }
  for (const line of f.split('\n').slice(0, rows.length)) {
    assert.match(line, /• a-long-first-column-value…  a-long-second/,
      'the mark survives the overflow whole; the text beside it truncates into its own gutter');
  }
});
