// The setup-backend screens, headless. The driver's ssh work is provision.ts,
// tested in provision.test.ts with an injected runner; here is what a person
// sees and types: name a target, paste a key — masked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { SetupTarget, SetupProviderKey } from './components/Setup.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = '\x1b[B', ESC = '\x1b';

test('SetupTarget: submits the typed target, empty is refused, esc backs out', async () => {
  let got: string | undefined, cancelled = false;
  const { lastFrame, stdin } = render(
    <SetupTarget onSubmit={(v) => { got = v; }} onCancel={() => { cancelled = true; }} />);
  await sleep(40);
  assert.match(strip(lastFrame() ?? ''), /root recommended/);
  stdin.write('\r'); await sleep(40);
  assert.equal(got, undefined, 'empty submit does nothing');
  stdin.write('root@1.2.3.4'); await sleep(40);
  stdin.write('\r'); await sleep(40);
  assert.equal(got, 'root@1.2.3.4');
  stdin.write(ESC); await sleep(40);
  assert.equal(cancelled, true);
});

test('SetupTarget: the parse error comes back onto the form', async () => {
  const { lastFrame } = render(
    <SetupTarget error="not a host: bad host" onSubmit={() => {}} onCancel={() => {}} />);
  await sleep(40);
  assert.match(strip(lastFrame() ?? ''), /not a host/);
});

test('SetupProviderKey: anthropic first, paste masked, saves the right setting key', async () => {
  let got: { settingKey: string; value: string; provider: string } | undefined;
  const { lastFrame, stdin } = render(
    <SetupProviderKey onSubmit={(v) => { got = v; }} onSkip={() => {}} />);
  await sleep(40);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /anthropic/);
  assert.match(f, /skip for now/);
  stdin.write('\r'); await sleep(40);           // anthropic is the first row
  assert.match(strip(lastFrame() ?? ''), /anthropic — paste the key/);
  stdin.write('sk-ant-xyz'); await sleep(40);
  assert.ok(!strip(lastFrame() ?? '').includes('sk-ant-xyz'), 'masked');
  stdin.write('\r'); await sleep(40);
  assert.deepEqual(got, { settingKey: 'anthropic_api_key', value: 'sk-ant-xyz', provider: 'anthropic' });
});

test('SetupProviderKey: the skip row skips', async () => {
  let skipped = false;
  const { stdin } = render(
    <SetupProviderKey onSubmit={() => {}} onSkip={() => { skipped = true; }} />);
  await sleep(40);
  for (let i = 0; i < 4; i++) { stdin.write(DOWN); await sleep(15); }  // past the four providers
  stdin.write('\r'); await sleep(40);
  assert.equal(skipped, true);
});
