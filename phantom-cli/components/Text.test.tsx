// The one door every drawn character goes through, and the rule that keeps it
// the only door.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { Text, screenText } from './Text.js';

test('a tab becomes spaces out to the next 8-column stop, per line', () => {
  assert.equal(screenText('origin\thttps://x (fetch)'), 'origin  https://x (fetch)');
  assert.equal(screenText('a\tb\n\tc'), 'a       b\n        c');
  assert.equal(screenText('12345678\tx'), '12345678        x');
});

test('control characters the terminal would act on are dropped; newline and colours stay', () => {
  assert.equal(screenText('progress 10%\rprogress 20%'), 'progress 10%progress 20%');
  assert.equal(screenText('a\x07b\x08c\x0cd\x7fe'), 'abcde');
  assert.equal(screenText('one\ntwo'), 'one\ntwo');
  assert.equal(screenText('\x1b[31mred\x1b[39m'), '\x1b[31mred\x1b[39m');
  assert.equal(screenText('plain'), 'plain');
});

test('Text cleans what it draws — a tab never reaches Ink', () => {
  const { lastFrame } = render(
    <Box flexDirection="column">
      <Text dimColor>{'origin\thttps://example (fetch)'}</Text>
      <Text>{['a', '\tb']}</Text>
      <Text>{'x\ry'}</Text>
    </Box>,
  );
  const frame = lastFrame() ?? '';
  assert.doesNotMatch(frame, /[\t\r]/);
  assert.match(frame, /origin {2}https:\/\/example \(fetch\)/);
  assert.match(frame, /a {8}b/);   // each string child is cleaned on its own, column 0
  assert.match(frame, /xy/);
});

/** Every source file under phantom-cli/, tests and the sidecar aside. */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'sidecar') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

test('components/Text.tsx is the ONLY file that imports Text from ink', () => {
  // The bug this pins: a tab in a tool result reached Ink's Text, Ink measured
  // it as zero cells, the terminal drew it eight wide, the row wrapped, and
  // every row below it — prompt, toolbar — was drawn one line low for the rest
  // of the session. One Text means nothing can hand Ink a character the
  // terminal will measure differently.
  const offenders = sources(new URL('..', import.meta.url).pathname)
    .filter((f) => !f.endsWith('/components/Text.tsx'))
    .filter((f) => {
      const m = readFileSync(f, 'utf8').match(/import \{([^}]*)\} from 'ink'/g) ?? [];
      return m.some((line) => /\bText\b/.test(line));
    });
  assert.deepEqual(offenders, [], 'these import Text from ink — use components/Text.js');
});
