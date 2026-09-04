// mouse.ts: the SGR report parser, the pane-clamped selection model, and the
// clipboard fallback. Plus: the App scrolls on a wheel report and the prompt
// never types one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from 'ai';
import { App } from './App.js';
import { Transcript } from './session.js';
import { inertVoice } from './voice.js';
import { isMouseInput, parseMouse, selectionRanges, copyToClipboard, MOUSE_ON, MOUSE_OFF } from './mouse.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('parseMouse: wheel, press, drag, release — with and without the leading ESC', () => {
  assert.deepEqual(parseMouse('\x1b[<64;10;5M'), { kind: 'wheel', button: -1, x: 9, y: 4, shift: false, meta: false, ctrl: false });
  assert.deepEqual(parseMouse('[<65;1;1M'), { kind: 'wheel', button: 1, x: 0, y: 0, shift: false, meta: false, ctrl: false });
  assert.equal(parseMouse('[<0;3;7M')?.kind, 'press');
  assert.equal(parseMouse('[<0;3;7m')?.kind, 'release');
  assert.equal(parseMouse('[<32;4;7M')?.kind, 'drag');
  assert.equal(parseMouse('[<2;3;7M')?.button, 2, 'right button');
  assert.equal(parseMouse('[<4;3;7M')?.shift, true);
  assert.equal(parseMouse('hello'), null);
  assert.equal(parseMouse('[<64;10;5'), null, 'incomplete: not ours');
  assert.ok(isMouseInput('[<64;10;5M'));
  assert.ok(!isMouseInput('[a'));
  assert.equal(MOUSE_ON, '\x1b[?1002h\x1b[?1006h');
  assert.equal(MOUSE_OFF, '\x1b[?1006l\x1b[?1002l');
});

test('selectionRanges: reading order, clamped to the pane it started in', () => {
  const region = { left: 0, right: 39 };
  // Same row, dragged left to right — and right to left gives the same range.
  assert.deepEqual(selectionRanges({ anchor: { x: 5, y: 2 }, head: { x: 12, y: 2 }, region }), [{ y: 2, x0: 5, x1: 12 }]);
  assert.deepEqual(selectionRanges({ anchor: { x: 12, y: 2 }, head: { x: 5, y: 2 }, region }), [{ y: 2, x0: 5, x1: 12 }]);
  // Three rows: tail of the first, whole middle, head of the last.
  assert.deepEqual(selectionRanges({ anchor: { x: 30, y: 1 }, head: { x: 4, y: 3 }, region }),
    [{ y: 1, x0: 30, x1: 39 }, { y: 2, x0: 0, x1: 39 }, { y: 3, x0: 0, x1: 4 }]);
  // Dragging into the other pane does not take its text: columns are clamped.
  const voice = { left: 41, right: 79 };
  assert.deepEqual(selectionRanges({ anchor: { x: 45, y: 0 }, head: { x: 10, y: 1 }, region: voice }),
    [{ y: 0, x0: 45, x1: 79 }, { y: 1, x0: 41, x1: 41 }]);
});

test('copyToClipboard falls back to OSC 52 on the terminal when no tool works', async () => {
  // Pretend to be a platform whose tools do not exist — the OSC 52 write is the last resort.
  const writes: string[] = [];
  const orig = process.platform;
  Object.defineProperty(process, 'platform', { value: 'freebsd' });
  try {
    const used = await copyToClipboard('hi there', { write: (s: string) => { writes.push(s); return true; } });
    assert.equal(used, 'osc52');
    assert.equal(writes[0], `\x1b]52;c;${Buffer.from('hi there').toString('base64')}\x07`);
  } finally {
    Object.defineProperty(process, 'platform', { value: orig });
  }
});

// ── in the App ───────────────────────────────────────────────────────────────
const fakeAgent = {
  stream: async () => ({
    stream: (async function* () {
      yield { type: 'text-start', id: 'x' }; yield { type: 'text-delta', id: 'x', text: 'reply ' + 'word '.repeat(30) };
      yield { type: 'text-end', id: 'x' }; yield { type: 'finish' };
    })(),
    responseMessages: Promise.resolve([]),
  }),
} as never;

function app() {
  const dir = mkdtempSync(join(tmpdir(), 'phantom-mouse-'));
  const cfg = join(dir, 's.json'); writeFileSync(cfg, '{}');
  return render(<App api={async () => ({})} newTools={async () => ({} as Record<string, Tool>)} configPath={cfg}
    initial={{ sessionId: 's1', branch: 'b', workspaceId: 'w', tools: {}, resumed: [] }}
    makeAgent={() => ({ agent: fakeAgent, summary: { provider: 't', model: 'm', reasoning: 'none', maxSteps: 1 } }) as never}
    makeTranscript={(h) => new Transcript(h, join(dir, 'x.jsonl'))} makeVoice={inertVoice} />);
}

test('a wheel report never lands in the prompt, and wheel-up scrolls the conversation back', async () => {
  const r = app();
  await sleep(50);
  for (let i = 0; i < 5; i++) { r.stdin.write(`q${i}`); await sleep(20); r.stdin.write('\r'); await sleep(200); }
  assert.match(strip(r.lastFrame()!), /› q4/, 'at the tail');
  r.stdin.write('\x1b[<64;10;5M'); await sleep(60);
  r.stdin.write('\x1b[<64;10;5M'); await sleep(60);
  r.stdin.write('\x1b[<64;10;5M'); await sleep(60);
  const f = strip(r.lastFrame()!);
  assert.ok(!/\[<64/.test(f), 'the report was not typed anywhere');
  assert.match(f, /type a message…/, 'the prompt is still empty');
  assert.ok(!/› q4/.test(f) || /› q0/.test(f), 'scrolled up: the newest line moved off, or the oldest came in');
  r.stdin.write('\x1b[<65;10;5M'); r.stdin.write('\x1b[<65;10;5M'); r.stdin.write('\x1b[<65;10;5M'); await sleep(80);
  assert.match(strip(r.lastFrame()!), /› q4/, 'wheel-down comes back to the tail');
  r.unmount();
});
