// A throw while drawing one region: the message reaches the caller once, the
// stack reaches console.error (cli.log in the app), the region draws nothing,
// and it comes back when resetKey changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { Boundary } from './Boundary.js';

function Bomb({ arm }: { arm: boolean }) {
  if (arm) throw new TypeError("Cannot read properties of undefined (reading 'length')");
  return <Text>fine</Text>;
}

test('a throw is reported once, drawn as nothing, and cleared by resetKey', () => {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  const reported: string[] = [];
  try {
    const r = render(
      <Boundary name="board" resetKey={1} onError={(m) => reported.push(m)}>
        <Text>before </Text><Bomb arm />
      </Boundary>);
    assert.deepEqual(reported, ["TypeError: Cannot read properties of undefined (reading 'length')"]);
    assert.ok(logged.some((l) => l.includes('board failed: TypeError') && l.includes('Bomb')), logged.join('\n'));
    assert.equal(r.lastFrame(), '');
    r.rerender(
      <Boundary name="board" resetKey={2} onError={(m) => reported.push(m)}>
        <Text>before </Text><Bomb arm={false} />
      </Boundary>);
    assert.equal(r.lastFrame(), 'before\nfine');
    assert.equal(reported.length, 1);
    r.unmount();
  } finally { console.error = orig; }
});
