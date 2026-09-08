// /presets: the three states of a preset key — set, clear, leave unchanged —
// their wording, their per-key descriptions, and clear as the default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { Presets } from './Presets.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = '\x1b[B', ENTER = '\r';

/** Poll the frame until it matches — keystrokes before the target screen has
 *  rendered land on the wrong list, so fixed sleeps flake under suite load. */
async function until(lastFrame: () => string | undefined, re: RegExp, ms = 3000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const f = strip(lastFrame() ?? '');
    if (re.test(f)) return f;
    if (Date.now() > deadline) assert.fail(`frame never matched ${re}; last frame:\n${f}`);
    await sleep(25);
  }
}

/** Send a key, retrying until the frame shows it landed. Ink writes frames
 *  on a throttle while useInput subscribes in a passive effect, so a key sent
 *  the moment a new screen first PAINTS can fall into the gap where no list
 *  is listening yet. */
async function press(lastFrame: () => string | undefined,
  stdin: { write: (s: string) => void }, key: string, re: RegExp, ms = 3000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    stdin.write(key);
    try { return await until(lastFrame, re, 300); }
    catch (e) { if (Date.now() > deadline) throw e; }
  }
}

interface PresetRow { id: string; name: string; values: Record<string, unknown> }

/** A fake backend: serves the given presets, captures every PUT body. */
function presetApi(presets: PresetRow[]) {
  const puts: Array<{ path: string; body: { name: string; values: Record<string, unknown> } }> = [];
  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    if (method === 'GET' && path === '/presets') return presets;
    if (method === 'PUT' && path.startsWith('/presets/')) {
      puts.push({ path, body: body as { name: string; values: Record<string, unknown> } });
      return {};
    }
    if (method === 'GET' && path === '/settings') return {};
    if (method === 'GET' && path.startsWith('/models')) return { models: [] };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, puts };
}

test('a new preset defaults every key to clear', async () => {
  const { api, puts } = presetApi([]);
  const { stdin, lastFrame } = render(<Presets api={api} onApplied={() => {}} onClose={() => {}} />);
  await until(lastFrame, /press \[n\] to create your first preset/);
  await press(lastFrame, stdin, 'n', /new preset/);
  stdin.write('work');
  await until(lastFrame, /name: work/);
  stdin.write(ENTER);
  const f = await until(lastFrame, /edit: work/);
  assert.equal(puts.length, 1, 'the preset was created');
  const values = puts[0].body.values;
  assert.equal(Object.keys(values).length, 15, 'all 15 keys are present');
  assert.ok(Object.values(values).every((v) => v === null),
    `every key starts clear (null): ${JSON.stringify(values)}`);
  assert.match(f, /∅ clear/, 'the editor shows every row as clear');
  assert.doesNotMatch(f, /· leave unchanged/, 'no key starts in the rare state');
});

test('the editor names each state and describes what apply does with it', async () => {
  const presets: PresetRow[] = [{ id: 'p1', name: 'mix', values: {
    provider: 'anthropic',        // set
    model: null,                  // clear
    assistant_model: null,        // clear, cascade key
    // everything else absent — leave unchanged
  } }];
  const { api } = presetApi(presets);
  const { stdin, lastFrame } = render(<Presets api={api} onApplied={() => {}} onClose={() => {}} />);
  await until(lastFrame, /mix/);
  await press(lastFrame, stdin, 'e', /apply writes this value: anthropic/);
  const f0 = strip(lastFrame() ?? '');
  assert.match(f0, /∅ clear/, 'a null key reads clear');
  assert.match(f0, /· leave unchanged/, 'an absent key reads leave unchanged');
  assert.match(f0, /cycle: clear \/ leave unchanged/, 'the footer uses the same words');

  const f = await press(lastFrame, stdin, DOWN,
    /clear — apply wipes this setting; the normal fallback takes over/);
  assert.ok(f, 'a clear row says what clear does');
  await press(lastFrame, stdin, DOWN, /leave unchanged — apply won't touch this setting/);
});

test('changing a provider resets its model to clear, not leave unchanged', async () => {
  const presets: PresetRow[] = [{ id: 'p1', name: 'main', values: {
    provider: 'anthropic', model: 'claude-sonnet-4-20250514',
  } }];
  const { api, puts } = presetApi(presets);
  const { stdin, lastFrame } = render(<Presets api={api} onApplied={() => {}} onClose={() => {}} />);
  await until(lastFrame, /main/);
  await press(lastFrame, stdin, 'e', /edit: main/);
  await press(lastFrame, stdin, ENTER, /current value/); // provider picker opens
  await press(lastFrame, stdin, DOWN, /❯ openai/);       // anthropic → openai
  stdin.write(ENTER);
  await until(lastFrame, /edit: main/);
  assert.equal(puts.length, 1, 'the change was saved');
  assert.equal(puts[0].body.values.provider, 'openai');
  assert.equal('model' in puts[0].body.values, true,
    'the model stays in the preset — as clear, not dropped to leave unchanged');
  assert.equal(puts[0].body.values.model, null);
});
