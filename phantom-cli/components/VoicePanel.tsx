// The Assistant's pane, on the right of the conversation: a three-line header
// (its state; its devices; its modes), then its chat — what you said, what it
// said, the tools it used — in a Pane of its own, following the tail. The same
// Part components as the conversation, so the two panes read alike.
//
// Line 2 is the devices row, `● mic · ● speaker`; line 3 is the modes row,
// `● wake · ● headphones`. An off switch is `⊘`, dim — the same glyph for all
// four because they are the same kind of switch, so "all on" is a glance.
// Clicking a glyph toggles it — the same toggles as /mic /speaker /headphones
// /wake, handed in as `onDevice`. No command hints in the rows (the slash menu
// has them): the pane is ~20 columns on a normal terminal and a hint cost more
// than it said. While `detail` stands (starting…, an error) it takes line 2
// and BOTH rows are hidden — the switches appear together, never one row
// ahead of the other. Detail WRAPS (nothing clickable sits under it while it
// stands, so the header may grow) — `installing engine (first run)…` and
// `install failed — see …/sidecar.log` cut to the pane's width said nothing;
// while starting it carries the dots spinner, because a first-run install is
// minutes of an otherwise still line. The per-stage ttfb (`dg stt 210ms · llm 480ms`) is
// tuning output, not day-to-day state, so it is one more line behind ctrl+o,
// the same key that reveals thinking.
import { Box, measureElement, useInput, type DOMElement } from 'ink';
import Spinner from 'ink-spinner';
import { Text } from './Text.js';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { isMouseInput, parseMouse } from '../mouse.js';
import type { VoiceSnapshot } from '../voice.js';
import { PartView } from './Parts.js';
import { Pane } from './Pane.js';

const LABEL: Record<VoiceSnapshot['status'], string> = {
  off: 'off', starting: 'starting', listening: 'listening', hearing: 'hearing you',
  thinking: 'thinking', speaking: 'speaking', error: 'error',
};
const COLOR: Partial<Record<VoiceSnapshot['status'], string>> = {
  listening: 'green', hearing: 'cyan', thinking: 'yellow', speaking: 'magenta', error: 'red',
};

// What you said, a touch softer than the agent's text (75% white).
const USER_COLOR = '#bfbfbf';

export type VoiceSwitch = 'mic' | 'speaker' | 'headphones' | 'wake';
interface SwitchItem { key: VoiceSwitch; label: string; on: boolean; accent?: boolean }

/** `● mic` when on, `⊘ mic` dim when off — single-cell glyphs only; emoji
 *  are two cells wide (and not reliably so), and the pane sits against a
 *  one-column divider that a misjudged width would wrap into. `accent` is the
 *  wake switch while its window is open: YELLOW, dot and label both, because
 *  that state means everything said is being heard and answered, and it must
 *  not blend into the steady green of a mere on. */
function Device({ name, on, accent }: { name: string; on: boolean; accent?: boolean }) {
  if (!on) return <Text dimColor>{`⊘ ${name}`}</Text>;
  return accent
    ? <Text color="yellow">{`● ${name}`}</Text>
    : <><Text color="green">●</Text><Text>{` ${name}`}</Text></>;
}

/** Each item's clickable span within its row: `X label` is 2 + label cells,
 *  ` · ` between items is 3. Computed from the SAME items the row renders, so
 *  the click targets cannot drift from the text (they used to be hand-measured
 *  numbers, with a warning comment begging them to be kept in sync). */
function spans(items: SwitchItem[]): Array<{ key: VoiceSwitch; from: number; to: number }> {
  const out: Array<{ key: VoiceSwitch; from: number; to: number }> = [];
  let x = 0;
  for (const it of items) {
    if (out.length) x += 3;
    out.push({ key: it.key, from: x, to: x + 2 + it.label.length });
    x += 2 + it.label.length;
  }
  return out;
}

function SwitchRow({ items, rowRef }: { items: SwitchItem[]; rowRef: MutableRefObject<DOMElement | null> }) {
  return (
    <Box ref={(n) => { rowRef.current = n; }}>
      <Text wrap="truncate-end">
        {items.map((it, i) => (
          <Text key={it.key}>
            {i > 0 ? <Text dimColor>{' · '}</Text> : null}
            <Device name={it.label} on={it.on} accent={it.accent} />
          </Text>
        ))}
      </Text>
    </Box>
  );
}

/** The ttfb line: `dg stt 210ms · llm 480ms`. */
function ttfbText(ttfb: VoiceSnapshot['ttfb']): string {
  return Object.entries(ttfb).filter(([, v]) => v > 0)   // pipecat sends zeros at start
    .map(([k, v]) => `${k.replace(/Service#\d+$/, '').replace(/^Deepgram/, 'dg ').replace(/LLM$/, '')} ${v}ms`).join(' · ');
}

export function VoicePanel({ width, voice, expanded, offset = 0, onMeasure, onDevice, approval, onApproval }: {
  width: number; voice: VoiceSnapshot; expanded: boolean;
  /** Rows up from the bottom (mouse wheel over the pane). */
  offset?: number;
  onMeasure?: (maxOffset: number) => void;
  /** A click on a switch glyph — the same toggle as its slash command. */
  onDevice?: (which: VoiceSwitch) => void;
  /** A gated tool waiting on the user: the Assistant's ask, so it shows HERE —
   *  what kind, the subject on its own row (the pane is ~20 columns and the
   *  subject is the thing being approved: it must not truncate away), then
   *  `accept · decline`. Click either word, or say it. */
  approval?: { label: string; subject: string } | null;
  onApproval?: (ok: boolean) => void;
}) {
  const inner = Math.max(10, width - 2);   // the padding column and a space
  const on = voice.status !== 'off';
  // `● mic · ● speaker` is 17 cells; the pane's floor is 16 wide (15 usable).
  const speaker = width - 1 >= 17 ? 'speaker' : 'spk';
  // While the wake window is open the switch becomes a yellow active mark —
  // `● active 6s`, counting down voice_wake_timeout — and drops back to
  // `● wake` the moment the window lapses. The countdown resets to the full
  // window on any audible speech (the sidecar pushes the deadline forward);
  // the tick below repaints this row once a second, only while it is counting.
  const awake = voice.wake && voice.awake;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!awake || voice.awakeUntil === null) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [awake, voice.awakeUntil]);
  const left = awake && voice.awakeUntil !== null
    ? Math.max(0, Math.ceil((voice.awakeUntil - Date.now()) / 1000)) : 0;
  const wakeLabel = awake ? (left > 0 ? `active ${left}s` : 'active') : 'wake';
  // `headphones` only when the whole modes row fits at the wake label's
  // current width (`● wake · ● headphones` is 21) — else `hp`.
  const phones = width - 1 >= 2 + wakeLabel.length + 3 + 12 ? 'headphones' : 'hp';
  const devices: SwitchItem[] = [
    { key: 'mic', label: 'mic', on: !voice.micMuted },
    { key: 'speaker', label: speaker, on: !voice.speakerMuted },
  ];
  const modes: SwitchItem[] = [
    { key: 'wake', label: wakeLabel, on: voice.wake, accent: awake },
    { key: 'headphones', label: phones, on: voice.headphones },
  ];
  // Both switch rows come and go TOGETHER: while `detail` stands (starting…,
  // an error) neither shows — the modes row alone, ahead of the devices row,
  // read as half a panel.
  const rowsOn = on && !voice.detail;
  const items = voice.live.length ? [...voice.done, ...voice.live] : voice.done;
  // The switch rows are clickable: hit-tested via measureElement against the
  // live layout (the CardEditor/Board pattern — never a hardcoded row). A
  // click resolves on release-without-drag, because drag in this pane already
  // means text selection: press on a row must still start a selection.
  const devicesRef = useRef<DOMElement | null>(null);
  const modesRef = useRef<DOMElement | null>(null);
  const answersRef = useRef<DOMElement | null>(null);
  const pressedRef = useRef<VoiceSwitch | 'accept' | 'decline' | null>(null);
  const hitRow = (ref: MutableRefObject<DOMElement | null>, row: SwitchItem[], x: number, y: number): VoiceSwitch | null => {
    const node = ref.current;
    if (!node) return null;
    const m = measureElement(node);
    if (y < m.y || y >= m.y + m.height) return null;
    const rel = x - m.x;
    return spans(row).find((s) => rel >= s.from && rel < s.to)?.key ?? null;
  };
  // `accept · decline` as a spans row of its own: accept is cells 0–5,
  // decline starts after the 3-cell separator.
  const hitAnswer = (x: number, y: number): 'accept' | 'decline' | null => {
    const node = answersRef.current;
    if (!node || !approval) return null;
    const m = measureElement(node);
    if (y < m.y || y >= m.y + m.height) return null;
    const rel = x - m.x;
    if (rel >= 0 && rel < 'accept'.length) return 'accept';
    const from = 'accept'.length + 3;
    return rel >= from && rel < from + 'decline'.length ? 'decline' : null;
  };
  const hit = (x: number, y: number): VoiceSwitch | 'accept' | 'decline' | null =>
    hitRow(devicesRef, devices, x, y) ?? hitRow(modesRef, modes, x, y) ?? hitAnswer(x, y);
  useInput((ch) => {
    if ((!onDevice && !onApproval) || !isMouseInput(ch)) return;
    const ev = parseMouse(ch);
    if (!ev || ev.button !== 0) return;
    if (ev.kind === 'press') { pressedRef.current = hit(ev.x, ev.y); return; }
    if (ev.kind === 'drag') { pressedRef.current = null; return; }
    if (ev.kind !== 'release') return;
    const target = pressedRef.current;
    pressedRef.current = null;
    if (!target || hit(ev.x, ev.y) !== target) return;
    if (target === 'accept' || target === 'decline') onApproval?.(target === 'accept');
    else onDevice?.(target);
  });
  return (
    <Box flexDirection="column" width={width} flexShrink={0} paddingLeft={1}>
      <Text>
        <Text bold>voice</Text>
        <Text dimColor>{' · '}</Text>
        <Text color={COLOR[voice.status]}>{LABEL[voice.status]}</Text>
      </Text>
      {voice.detail
        ? <Box>
            {voice.status === 'starting' ? <Box flexShrink={0}><Text color="yellow"><Spinner type="dots" /></Text><Text> </Text></Box> : null}
            <Text dimColor>{voice.detail}</Text>
          </Box>
        : !on
          ? <Text dimColor>{'/voice to set up and turn on'}</Text>
          : <SwitchRow items={devices} rowRef={devicesRef} />}
      {rowsOn ? <SwitchRow items={modes} rowRef={modesRef} /> : null}
      {/* ctrl+o: the ttfb row. Drawn (blank until the first metric) whenever
          expanded, so toggling it moves the chat by exactly one row, once. */}
      {expanded && on ? <Text dimColor wrap="truncate-end">{ttfbText(voice.ttfb) || ' '}</Text> : null}
      {/* Finished AND in-flight parts in ONE list: a partial transcript grows
          in place and becomes the final line where it already is, and the reply
          streams where it will end up. Two blocks (done above, live below) had
          the partial appear at the bottom and then jump to the top when it
          finalised. */}
      {/* One blank row above and below the chat, so it never touches the header
          or the bottom edge. */}
      <Text> </Text>
      <Pane items={items} offset={offset} width={inner} onMeasure={onMeasure} keyFor={(p) => p.id}
        render={(p) => <PartView key={p.id} part={p} width={inner} expanded={expanded} maxRows={8} userColor={USER_COLOR} compactTools />} />
      {/* The ask sits UNDER the chat — where the Assistant's newest words
          are — as a fixed block the Pane above shrinks around, so an ask
          arriving at the tail pushes the chat up rather than covering it. */}
      {approval ? (
        <Box flexDirection="column" flexShrink={0}>
          <Text color="yellow" wrap="truncate-end">{`${approval.label}?`}</Text>
          <Text color="yellow" bold wrap="truncate-end">{approval.subject}</Text>
          <Box ref={(n) => { answersRef.current = n; }}>
            <Text wrap="truncate-end">
              <Text color="green">accept</Text>
              <Text dimColor>{' · '}</Text>
              <Text color="red">decline</Text>
            </Text>
          </Box>
        </Box>
      ) : null}
      <Text> </Text>
    </Box>
  );
}
