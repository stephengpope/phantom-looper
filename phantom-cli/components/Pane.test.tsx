// The pane is the ONLY way to reach a session's history (the app draws on the
// alternate screen and puts nothing in the terminal's scrollback), so two
// things are pinned here:
//   - you can reach the first message of a long conversation;
//   - what a frame costs is the size of the screen, not the size of the
//     conversation — the window drops what is above AND below the view.
// The first one is a bug that shipped: the window only ever grew, and it could
// not grow past the first batch, so history stopped 40 messages back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { useEffect, useRef, useState } from 'react';
import { Text } from './Text.js';
import { Pane } from './Pane.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for what the frame says, rather than for a fixed delay: the scrolling
 *  below advances one measured layout at a time, and how many event-loop turns
 *  that takes depends on what else the suite is doing. */
async function until(check: () => boolean, ms = 8000): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) { if (check()) return; await sleep(10); }
}

/** The caller's half of the contract, exactly as App has it: the scroll is
 *  clamped to whatever the pane last said it can show, and a page up is a
 *  fixed number of rows. Each page up waits for the pane to report again —
 *  which is what pressing the key repeatedly does, minus the human.  */
function Scroller({ items, rows, ups, step = 6, drawn, tall = false, track }: {
  items: string[]; rows: number; ups: number; step?: number;
  /** Counts what the pane actually laid out, per frame. */
  drawn?: (index: number) => void;
  tall?: boolean;
  /** How many page ups have happened, for a test that waits on progress
   *  rather than on the clock. */
  track?: { ups: number };
}) {
  const [scroll, setScroll] = useState(0);
  const [max, setMax] = useState(0);
  const maxRef = useRef(0);
  maxRef.current = max;
  // A key press every few milliseconds, on a timer — NOT an effect that fires
  // on its own result. Pressing pageUp is an event from outside React, and a
  // render→scroll→render chain is a nested update React refuses (it also
  // stops the pane from ever settling between presses, which is not what
  // holding the key down does).
  useEffect(() => {
    if (!ups) return;
    let n = 0;
    const t = setInterval(() => {
      setScroll((s) => Math.max(0, Math.min(maxRef.current, s + step)));
      n += 1;
      if (track) track.ups = n;
      if (n >= ups) clearInterval(t);
    }, 4);
    return () => clearInterval(t);
  }, [ups, step, track]);
  return (
    <Box height={rows} flexDirection="column">
      <Pane items={items} offset={scroll} width={40} onMeasure={setMax} keyFor={(t) => t}
        render={(t, i) => { drawn?.(i); return tall
          ? <Box flexDirection="column"><Text>{t}</Text><Text>{'.'}</Text><Text>{'.'}</Text></Box>
          : <Text>{t}</Text>; }} />
    </Box>
  );
}

const msgs = (n: number) => Array.from({ length: n }, (_, i) => `msg ${i}`);

const topRow = (frame: string | undefined) => (frame ?? '').split('\n')[0].trim();
const lines = (frame: string | undefined) =>
  (frame ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
/** The frame holds this message, whole — the assertion for items taller than
 *  one row, where the top row of the view can be an item's second line. */
const shows = (frame: string | undefined, msg: string) => lines(frame).includes(msg);

test('history is reachable to its first message', async () => {
  const r = render(<Scroller items={msgs(300)} rows={12} ups={200} />);
  await until(() => topRow(r.lastFrame()) === 'msg 0');
  const top = topRow(r.lastFrame());
  r.unmount();
  // Before the fix this stopped at `msg 260` — 40 items back, every time.
  assert.equal(top, 'msg 0');
});

test('items of several rows scroll to the top too', async () => {
  const r = render(<Scroller items={msgs(200)} rows={10} ups={400} step={9} tall />);
  await until(() => shows(r.lastFrame(), 'msg 0'));
  const reached = shows(r.lastFrame(), 'msg 0');
  r.unmount();
  assert.ok(reached, `the first message never came into view: ${r.lastFrame()}`);
});

test('a frame draws a screenful, however long the conversation is', async () => {
  const cost = async (n: number) => {
    let most = 0, frame = new Set<number>();
    let ticks = 0;
    const track = { ups: 0 };
    const r = render(<Scroller items={msgs(n)} rows={12} ups={40} track={track}
      drawn={(i) => {
        // Items arrive in order within a frame; a lower index than the last
        // means a new frame started.
        if (frame.has(i)) { most = Math.max(most, frame.size); frame = new Set(); ticks++; }
        frame.add(i);
      }} />);
    await until(() => track.ups >= 40);
    r.unmount();
    most = Math.max(most, frame.size);
    return { most, ticks };
  };
  const small = await cost(300);
  const huge = await cost(20000);
  // The window is bounded by the screen (12 rows + a screenful of overscan),
  // not by the list: 20,000 messages must not cost more than 300 do.
  assert.ok(huge.most <= 60, `drew ${huge.most} items of 20,000 in one frame`);
  assert.ok(huge.most <= small.most + 10,
    `20,000 messages drew ${huge.most} per frame, 300 drew ${small.most}`);
});

test('the tail is exact, and short content sits at the top', async () => {
  const r = render(<Scroller items={msgs(300)} rows={6} ups={0} />);
  await until(() => lines(r.lastFrame()).length > 0);
  const tail = lines(r.lastFrame());
  r.unmount();
  // Following the tail: the newest message is the last row, nothing below it.
  assert.equal(tail[tail.length - 1], 'msg 299');

  const short = render(<Scroller items={msgs(3)} rows={10} ups={0} />);
  await until(() => lines(short.lastFrame()).length === 3);
  const all = lines(short.lastFrame());
  short.unmount();
  assert.deepEqual(all, ['msg 0', 'msg 1', 'msg 2']);
});

/** The App's repaint-on-resize collapses the screen to 0×0 for one frame. */
function Squeezed({ items }: { items: string[] }) {
  const [rows, setRows] = useState(12);
  useEffect(() => {
    const a = setTimeout(() => setRows(0), 20);
    const b = setTimeout(() => setRows(12), 60);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, []);
  return (
    <Box height={rows} flexDirection="column">
      <Pane items={items} offset={0} width={40} keyFor={(t) => t}
        render={(t) => <Box flexDirection="column"><Text>{t}</Text><Text>{'.'}</Text><Text>{'.'}</Text></Box>} />
    </Box>
  );
}

test('a pane squeezed to no height for a frame comes back where it was', async () => {
  // Before the fix this threw "Maximum update depth exceeded" from Ink's
  // layout listener: every item measured 0 rows in the collapsed frame and
  // the window walked up the list one commit at a time.
  const r = render(<Squeezed items={msgs(300)} />);
  await until(() => shows(r.lastFrame(), 'msg 299'));
  await sleep(120);
  const tail = shows(r.lastFrame(), 'msg 299');
  r.unmount();
  assert.ok(tail, `the tail was lost after the squeeze: ${r.lastFrame()}`);
});
