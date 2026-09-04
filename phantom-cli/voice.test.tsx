// The voice client against a scripted sidecar and a scripted brain, and the
// App with the voice pane on. No Python, no audio, no model: the spawner seam
// hands in a fake process; the agent seam hands in a fake agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage, Tool } from 'ai';
import { App } from './App.js';
import { Transcript } from './session.js';
import {
  VoiceClient, sidecarEnv, sessionsTool, nthAssistantIndex, truncateAssistant, kebabName,
  type Spawner, type VoiceIn,
} from './voice.js';
import { DEFAULTS, REMOTE_DEFAULTS, isLocalKey, type ConfigKey, type ConfigValue } from './config.js';
import { localValues } from './local.js';
import type { Agent } from './agent.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const tmp = () => mkdtempSync(join(tmpdir(), 'phantom-voice-'));

/** A sidecar that never runs: we see what the client sends and feed it lines. */
function fakeSidecar() {
  let onLine: (l: string) => void = () => {};
  let onExit: (c: number | null, d?: string) => void = () => {};
  const sent: Record<string, unknown>[] = [];
  let envSeen: Record<string, string> = {};
  let spawns = 0;
  const spawner: Spawner = async (env, line, exit) => {
    envSeen = env; onLine = line; onExit = exit; spawns++;
    return { send: (l) => { for (const x of l.split('\n')) if (x.trim()) sent.push(JSON.parse(x)); }, kill: () => {} };
  };
  return {
    spawner, sent,
    env: () => envSeen,
    spawns: () => spawns,
    emit: (m: VoiceIn) => onLine(JSON.stringify(m)),
    raw: (l: string) => onLine(l),
    exit: (c: number | null) => onExit(c),
    ofType: (t: string) => sent.filter((m) => m.type === t),
  };
}

const ready = (): VoiceIn => ({ type: 'ready', devices: { mics: [], speakers: [] }, mic: '', speaker: '', voice: 'v' });

/** A brain that says `text` (one step), one word per tick, honouring abort.
 *  `steps` lets a test script more than one step (a tool call between). */
function scriptedAgent(opts: { text?: string; delayMs?: number; steps?: Array<{ parts: unknown[]; messages: ModelMessage[] }> } = {}): Agent {
  const words = (opts.text ?? 'Just one, s1.').split(/(?<= )/);
  const steps = opts.steps ?? [{
    parts: [
      { type: 'start-step' },
      { type: 'text-start', id: 'x' },
      ...words.map((w) => ({ type: 'text-delta', id: 'x', text: w })),
      { type: 'text-end', id: 'x' },
      { type: 'finish-step' },
    ],
    messages: [{ role: 'assistant', content: opts.text ?? 'Just one, s1.' }],
  }];
  const delayMs = opts.delayMs ?? 0;
  return {
    // Mirrors createAgent's RecordingAgent contract: `record` gets each
    // step's messages + usage exactly as the real agent writes it.
    stream: async ({ abortSignal, onStepEnd, record }: { abortSignal?: AbortSignal;
      onStepEnd?: (s: unknown) => void;
      record?: { appendStep: (m: unknown[], u?: unknown) => void } }) => ({
      stream: (async function* () {
        yield { type: 'start' };
        for (const step of steps) {
          for (const p of step.parts) {
            if (abortSignal?.aborted) { yield { type: 'abort' }; return; }
            yield p;
            if (delayMs) await sleep(delayMs);
          }
          if (abortSignal?.aborted) { yield { type: 'abort' }; return; }
          record?.appendStep(step.messages, undefined);
          onStepEnd?.({ response: { messages: step.messages } });
        }
        yield { type: 'finish' };
      })(),
      responseMessages: Promise.resolve(steps.flatMap((s) => s.messages)),
    }),
  } as never;
}

test('start: no handshake; ready brings the devices and the listening state; the env is the audio side only', async () => {
  const f = fakeSidecar();
  const v = new VoiceClient(f.spawner, null);
  await v.start({ X: '1' });
  assert.equal(v.snapshot().status, 'starting');
  assert.equal(f.sent.length, 0, 'nothing to say until asked');
  assert.equal(f.env().X, '1');
  f.emit({ type: 'ready', devices: { mics: ['Mic A'], speakers: ['Spk B'] }, mic: '', speaker: '', voice: 'v' });
  assert.equal(v.snapshot().status, 'listening');
  assert.deepEqual(v.snapshot().devices, { mics: ['Mic A'], speakers: ['Spk B'] });
});

test('a turn: what you said lands as a part and in the day file, the brain runs, the reply is spoken step by step and shown', async () => {
  const f = fakeSidecar();
  const dir = tmp();
  const v = new VoiceClient(f.spawner, dir);
  v.setAgent(scriptedAgent({ text: 'Just one, s1.' }));
  await v.start({});
  f.emit(ready());
  f.emit({ type: 'user', text: 'which', final: false });
  assert.equal((v.snapshot().live[0] as { text: string }).text, 'which', 'the transcript as it forms');
  f.emit({ type: 'user', text: 'which sessions', final: true });
  assert.equal((v.snapshot().live[0] as { text: string }).text, 'which sessions', 'a confirmed segment stays on screen');
  assert.equal(v.snapshot().done.length, 0, 'a final transcript is not a turn');
  f.emit({ type: 'turn', text: 'which sessions are open' });
  assert.equal(v.snapshot().live.length, 0, 'the committed turn replaces the forming line');
  assert.equal((v.snapshot().done.at(-1) as { text: string }).text, 'which sessions are open', 'the turn is what you said');
  assert.equal(v.snapshot().status, 'thinking');
  await sleep(40);
  assert.deepEqual(f.ofType('speak_start'), [{ type: 'speak_start', turn: 'vt1', step: 1 }]);
  assert.equal(f.ofType('speak_delta').map((m) => m.text).join(''), 'Just one, s1.');
  assert.deepEqual(f.ofType('speak_end'), [{ type: 'speak_end', turn: 'vt1' }]);
  const last = v.snapshot().done.at(-1) as { kind: string; text: string; done: boolean };
  assert.equal(last.kind, 'text'); assert.equal(last.text, 'Just one, s1.'); assert.equal(last.done, true);
  assert.deepEqual(v.history.map((m) => m.role), ['user', 'assistant']);
  assert.equal(v.snapshot().status, 'listening');
  assert.ok(v.snapshot().ttfb.llm >= 0, 'the llm ttfb is measured here');
  // The record is the SAME transcript format every agent writes
  // (core/llm/transcript.ts): header with the frozen prompt, then messages.
  const file = readdirSync(dir).find((n) => n.endsWith('.jsonl'))!;
  const lines = readFileSync(join(dir, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'session');
  assert.equal(lines[0].agent, 'assistant');
  assert.match(String(lines[0].system_prompt), /Assistant inside phantom-looper/);
  assert.deepEqual(lines.slice(1).map((l) => l.role ?? l.type), ['user', 'assistant', 'usage'],
    'messages plus the step\'s usage line — the record every agent leaves');
  assert.equal(lines[1].content, 'which sessions are open');
  // The speaking state is the sidecar's word, and it outlasts the stream.
  f.emit({ type: 'status', speaking: true });
  assert.equal(v.snapshot().status, 'speaking');
  f.emit({ type: 'spoken', turn: 'vt1', step: 1, text: 'Just one, s1.', interrupted: false });
  assert.deepEqual(v.history.map((m) => m.role), ['user', 'assistant'], 'said in full: nothing to fix');
  f.emit({ type: 'status', speaking: false });
  assert.equal(v.snapshot().status, 'listening');
});

test('the forming transcript never leaves the screen: finals fold in, the next guess appends, turn replaces it in place', async () => {
  const f = fakeSidecar();
  const v = new VoiceClient(f.spawner, null);
  v.setAgent(scriptedAgent({ text: 'ok' }));
  await v.start({});
  f.emit(ready());
  const line = () => v.snapshot().live[0] as { id: string; text: string } | undefined;
  // STT confirms per segment, several times per turn; each confirmation used
  // to blank the line until `turn` landed seconds later. Now it folds in.
  f.emit({ type: 'user', text: 'we should', final: false });
  const id = line()!.id;
  f.emit({ type: 'user', text: 'we should fix', final: true });
  assert.equal(line()!.text, 'we should fix');
  f.emit({ type: 'user', text: 'the', final: false });
  assert.equal(line()!.text, 'we should fix the', 'the next guess appends after what is confirmed');
  f.emit({ type: 'user', text: 'the flicker', final: false });
  assert.equal(line()!.text, 'we should fix the flicker', 'a guess replaces the guess, not the confirmed text');
  f.emit({ type: 'user', text: 'the flicker', final: true });
  assert.equal(line()!.text, 'we should fix the flicker');
  assert.equal(line()!.id, id, 'one part start to finish — the pane never remounts it');
  f.emit({ type: 'turn', text: 'we should fix the flicker' });
  assert.equal(v.snapshot().live.length, 0);
  assert.equal((v.snapshot().done.at(-1) as { text: string }).text, 'we should fix the flicker');
  await sleep(20);
});

test('cut off while generating: interrupted aborts the stream; spoken trims the history to what was heard', async () => {
  const f = fakeSidecar();
  const v = new VoiceClient(f.spawner, null);
  v.setAgent(scriptedAgent({ text: 'There are three sessions, the first one is busy.', delayMs: 15 }));
  await v.start({});
  f.emit(ready());
  f.emit({ type: 'turn', text: 'what is open' });
  await sleep(70);   // a few words out
  const before = f.ofType('speak_delta').length;
  assert.ok(before >= 2 && before < 9, `mid-stream: ${before} deltas`);
  f.emit({ type: 'interrupted' });
  f.emit({ type: 'interrupted' });   // pipecat broadcasts it both ways — twice is fine
  await sleep(40);
  assert.equal(f.ofType('speak_delta').length, before, 'no more deltas after the abort');
  assert.deepEqual(v.history.map((m) => m.role), ['user'], 'the aborted step was never recorded');
  assert.equal(v.busy, false);
  f.emit({ type: 'spoken', turn: 'vt1', step: 1, text: 'There are three sessions,', interrupted: true });
  assert.deepEqual(v.history.map((m) => m.role), ['user', 'assistant']);
  assert.equal(v.history[1].content, 'There are three sessions,', 'the model remembers what you heard, not the rest');
  const shown = v.snapshot().done.filter((p) => p.kind === 'text') as { text: string }[];
  assert.equal(shown.at(-1)?.text, 'There are three sessions,', 'the pane agrees');
});

test('cut off after generating (the common case — the model is faster than speech): the recorded step is trimmed', async () => {
  const f = fakeSidecar();
  const v = new VoiceClient(f.spawner, null);
  v.setAgent(scriptedAgent({ text: 'One is busy. Two is idle. Three is new.' }));
  await v.start({});
  f.emit(ready());
  f.emit({ type: 'turn', text: 'status' });
  await sleep(30);
  assert.equal(v.history[1].content, 'One is busy. Two is idle. Three is new.');
  f.emit({ type: 'interrupted' });
  f.emit({ type: 'spoken', turn: 'vt1', step: 1, text: 'One is busy. Two is', interrupted: true });
  assert.equal(v.history.length, 2);
  assert.equal(v.history[1].content, 'One is busy. Two is');
  assert.equal((v.snapshot().done.at(-1) as { text: string }).text, 'One is busy. Two is');
});

test('a new turn while one runs replaces it (you spoke over it); cancel aborts and tells the sidecar', async () => {
  const f = fakeSidecar();
  const v = new VoiceClient(f.spawner, null);
  v.setAgent(scriptedAgent({ text: 'a b c d e f g h i j k', delayMs: 10 }));
  await v.start({});
  f.emit(ready());
  f.emit({ type: 'turn', text: 'first' });
  await sleep(35);
  f.emit({ type: 'turn', text: 'second' });
  await sleep(200);
  const starts = f.ofType('speak_start');
  assert.deepEqual(starts.map((m) => m.turn), ['vt1', 'vt2']);
  assert.deepEqual(v.history.filter((m) => m.role === 'user').map((m) => m.content), ['first', 'second']);
  assert.equal(v.history.filter((m) => m.role === 'assistant').length, 1, 'only the second turn finished');
  f.emit({ type: 'turn', text: 'third' });
  await sleep(25);
  v.cancel();
  assert.deepEqual(f.sent.at(-1), { type: 'cancel' });
  await sleep(30);
  assert.equal(v.busy, false);
});

test('a tool call in the brain shows as a tool row that completes', async () => {
  const f = fakeSidecar();
  const v = new VoiceClient(f.spawner, null);
  v.setAgent(scriptedAgent({ steps: [
    { parts: [{ type: 'start-step' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'sessions', input: { action: 'list' } },
      { type: 'tool-result', toolCallId: 'c1', toolName: 'sessions', input: { action: 'list' }, output: { sessions: [] } }, { type: 'finish-step' }],
      messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'sessions', input: { action: 'list' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'sessions', output: { type: 'json', value: { sessions: [] } } }] }] },
    { parts: [{ type: 'start-step' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', text: 'None open.' }, { type: 'text-end', id: 't' }, { type: 'finish-step' }],
      messages: [{ role: 'assistant', content: 'None open.' }] },
  ] }));
  await v.start({});
  f.emit(ready());
  f.emit({ type: 'turn', text: 'what is open' });
  await sleep(40);
  const tool = v.snapshot().done.find((p) => p.kind === 'tool') as { name: string; status: string };
  assert.equal(tool.name, 'sessions'); assert.equal(tool.status, 'ok');
  assert.deepEqual(f.ofType('speak_start').map((m) => m.step), [1, 2], 'one speak per step');
  assert.equal(f.ofType('speak_delta').map((m) => m.text).join(''), 'None open.');
  assert.deepEqual(v.history.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  // Cut off during step 2's audio: step 2 is the turn's second assistant message.
  f.emit({ type: 'spoken', turn: 'vt1', step: 2, text: 'None', interrupted: true });
  assert.equal(v.history[3].content, 'None');
});

test('say, mic, speaker and set go down the wire; stop says shutdown and turns off', async () => {
  const f = fakeSidecar();
  const v = new VoiceClient(f.spawner, null);
  v.setAgent(scriptedAgent({ text: 'Hello.' }));
  assert.equal(v.say('x'), false, 'nothing to say to while off');
  await v.start({});
  assert.equal(v.say('hi there'), true);
  assert.equal((v.snapshot().done.at(-1) as { text: string }).text, 'hi there', 'shown as yours at once');
  await sleep(20);
  assert.equal(f.ofType('speak_delta').map((m) => m.text).join(''), 'Hello.', 'typed text is answered like speech');
  v.setMic(true);
  assert.deepEqual(f.sent.at(-1), { type: 'mic', muted: true });
  assert.equal(v.snapshot().micMuted, true);
  v.setSpeaker(true);
  assert.deepEqual(f.sent.at(-1), { type: 'speaker', muted: true });
  v.update({ voice: 'aura-2-orion-en' });
  assert.deepEqual(f.sent.at(-1), { type: 'set', voice: 'aura-2-orion-en' });
  v.stop();
  assert.deepEqual(f.sent.at(-1), { type: 'shutdown' });
  assert.equal(v.snapshot().status, 'off');
  assert.equal(v.running, false);
});

test('no model set: a turn says so instead of dying', async () => {
  const f = fakeSidecar();
  const v = new VoiceClient(f.spawner, null);
  await v.start({});
  f.emit({ type: 'turn', text: 'hello' });
  await sleep(10);
  assert.match(String((v.snapshot().done.at(-1) as { message?: string }).message), /no model/);
  assert.equal(f.ofType('speak_start').length, 0);
});

test('an error line and a dead process both show as error; garbage lines are ignored', async () => {
  const f = fakeSidecar();
  const v = new VoiceClient(f.spawner, null);
  await v.start({});
  f.raw('||PaMacCore|| something not json');
  assert.equal(v.snapshot().status, 'starting');
  f.emit({ type: 'error', message: 'voice needs a deepgram key — set it on /keys' });
  assert.equal(v.snapshot().status, 'error');
  assert.match(String(v.snapshot().detail), /deepgram key/);
  f.exit(1);
  assert.match(String(v.snapshot().detail), /stopped|exit/);
  assert.equal(v.running, false);
});

test('a warn line is a note in the pane and leaves the status alone', async () => {
  const f = fakeSidecar();
  const v = new VoiceClient(f.spawner, null);
  await v.start({});
  f.emit(ready());
  assert.equal(v.snapshot().status, 'listening');
  f.emit({ type: 'warn', message: 'Error getting audio: Connection timeout to host' });
  assert.equal(v.snapshot().status, 'listening', 'the engine carries on — a warn never flips the status');
  const last = v.snapshot().done.at(-1) as { kind: string; message?: string };
  assert.equal(last.kind, 'error');
  assert.match(String(last.message), /Connection timeout/);
  assert.equal(v.running, true);
});

test('refreshDevices re-scans every time: asks a running agent, runs the lister when off', async () => {
  const f = fakeSidecar();
  const v = new VoiceClient(f.spawner, null);
  let listed = 0;
  const lister = async () => { listed++; return { mics: ['New Mic'], speakers: [] }; };
  await v.refreshDevices(lister);
  assert.equal(listed, 1);
  assert.deepEqual(v.snapshot().devices.mics, ['New Mic']);
  await v.refreshDevices(lister);
  assert.equal(listed, 2, 'not cached — a device plugged in later must show up');
  await v.start({});
  await v.refreshDevices(lister);
  assert.equal(listed, 2, 'running: the agent is asked instead');
  assert.deepEqual(f.sent.at(-1), { type: 'devices' });
  f.emit({ type: 'devices', devices: { mics: ['New Mic', 'Newer Mic'], speakers: ['Spk'] } });
  assert.deepEqual(v.snapshot().devices, { mics: ['New Mic', 'Newer Mic'], speakers: ['Spk'] });
});

test('sidecarEnv: the audio side only — no provider, no model, no model key', () => {
  const base = { ...DEFAULTS } as Record<ConfigKey, ConfigValue>;
  const env = sidecarEnv({ ...base, provider: 'openai', openai_api_key: 'sk-o', base_url: 'http://x', model: 'gpt', deepgram_api_key: 'dg',
    voice_mic_device: 'RODE', voice_mic_muted: true, voice_speaker_muted: true,
    voice_headphones: true, voice_wake_word: true, voice_wake_words: 'hey, you' });
  assert.equal(env.DEEPGRAM_API_KEY, 'dg');
  assert.equal(env.PHANTOM_CLI_VOICE_MIC, 'RODE');
  assert.equal(env.PHANTOM_CLI_VOICE_STT_MODEL, 'nova-3', 'the hearing model is the shared server setting, defaulting to nova-3');
  assert.equal(sidecarEnv({ ...base, voice_stt_model: 'nova-2' }).PHANTOM_CLI_VOICE_STT_MODEL, 'nova-2');
  assert.equal(env.PHANTOM_CLI_VOICE_MIC_MUTED, '1');
  assert.equal(env.PHANTOM_CLI_VOICE_SPEAKER_MUTED, '1');
  assert.equal(env.PHANTOM_CLI_VOICE_HEADPHONES, '1');
  assert.equal(env.PHANTOM_CLI_VOICE_WAKE, '1');
  assert.equal(env.PHANTOM_CLI_VOICE_WAKE_WORDS, 'hey, you');
  assert.ok(!Object.values(env).includes('sk-o'), 'the model key never reaches the sidecar');
  // The two Deepgram facts are the sidecar's own; the brain's model and key are not.
  const audioOwn = new Set(['DEEPGRAM_API_KEY', 'PHANTOM_CLI_VOICE_STT_MODEL']);
  assert.ok(!Object.keys(env).some((k) => /PROVIDER|MODEL|API_KEY|BASE_URL/.test(k) && !audioOwn.has(k)), Object.keys(env).join());
});

test('nthAssistantIndex and truncateAssistant: the step-th reply of a turn, text swapped, tool calls kept', () => {
  const h: ModelMessage[] = [
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'old' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 't', input: {} }, { type: 'text', text: 'first, then second' }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 't', output: { type: 'json', value: {} } }] },
    { role: 'assistant', content: 'done' },
  ];
  assert.equal(nthAssistantIndex(h, 2, 1), 3);
  assert.equal(nthAssistantIndex(h, 2, 2), 5);
  assert.equal(nthAssistantIndex(h, 2, 3), -1);
  const t = truncateAssistant(h[3], 'first,') as { content: Array<{ type: string; text?: string }> };
  assert.deepEqual(t.content.map((c) => c.type), ['tool-call', 'text']);
  assert.equal(t.content[1].text, 'first,');
  assert.equal((truncateAssistant(h[5], 'do') as { content: string }).content, 'do');
  assert.equal(truncateAssistant(h[0], 'x'), h[0], 'not an assistant message: untouched');
});

// ── the App with voice on ────────────────────────────────────────────────────
const noApi = async () => ({});
const fakeAgent = {
  stream: async () => ({
    stream: (async function* () { yield { type: 'finish' }; })(),
    responseMessages: Promise.resolve([]),
  }),
} as never;

function appWithVoice(cfg: Record<string, ConfigValue>, brain: Agent = scriptedAgent(), api = noApi, newAssistantTools?: (id: string) => Promise<Record<string, Tool>>) {
  const dir = tmp();
  const configPath = join(dir, 'settings.json');
  // The split, exercised: only the eight machine-local keys go in the file;
  // everything else arrives as the server's answer.
  const local = Object.fromEntries(Object.entries(cfg).filter(([k]) => isLocalKey(k)));
  const remoteCfg = { ...REMOTE_DEFAULTS,
    ...Object.fromEntries(Object.entries(cfg).filter(([k]) => !isLocalKey(k))) };
  writeFileSync(configPath, JSON.stringify(local));
  // Settings come off the API now, so the fake one has to serve them — the
  // sidecar reads its key at spawn, which is the whole point.
  const wrap = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));
  // A real store, not a fixed snapshot: a write has to be visible to the next
  // read, because reading after writing is the whole point.
  const stored: Record<string, unknown> = { ...remoteCfg };
  const withSettings = async (m: string, p: string, b?: unknown) => {
    if (p.startsWith('/settings')) {
      if (m === 'GET') return wrap(stored);
      if (m === 'PATCH') { Object.assign(stored, b as object); return {}; }
      return {};
    }
    return (api as (m: string, p: string, b?: unknown) => Promise<unknown>)(m, p, b);
  };
  const f = fakeSidecar();
  const voice = new VoiceClient(f.spawner, null);
  let voiceTools: Record<string, Tool> = {};
  const r = render(
    <App api={withSettings as never} newTools={async () => ({} as Record<string, Tool>)} configPath={configPath} newAssistantTools={newAssistantTools}
      bootConfig={remoteCfg as Record<string, ConfigValue>}
      initial={{ sessionId: 's1', branch: 'agent/s1', workspaceId: 'w1', tools: {}, resumed: [] as ModelMessage[] }}
      makeAgent={() => ({ agent: fakeAgent, summary: { provider: 'test', model: 'fake', reasoning: 'none', maxSteps: 1 } }) as never}
      makeAssistantAgent={(tools) => { voiceTools = tools; return { agent: brain, summary: { provider: 'test', model: 'fake', reasoning: 'none', maxSteps: 1 } }; }}
      makeTranscript={(h) => new Transcript(h, join(dir, 'x.jsonl'))}
      makeVoice={() => voice} />,
  );
  return { ...r, f, voice, configPath, tools: () => voiceTools };
}

test('with voice enabled the pane is there from the first frames and the sidecar is started with the audio env', async () => {
  const { lastFrame, f, tools } = appWithVoice({ voice_enabled: true, sidebar_width: 30, deepgram_api_key: 'dg', anthropic_api_key: 'k' });
  await sleep(80);
  const frame = strip(lastFrame() ?? '');
  assert.match(frame, /voice · starting/);
  assert.doesNotMatch(frame, /[●⊘] wake/, 'no switch row before ready — they appear together');
  assert.doesNotMatch(frame, /[●⊘] mic/);
  assert.equal(f.env().DEEPGRAM_API_KEY, 'dg');
  assert.equal(f.env().PHANTOM_CLI_VOICE_API_KEY, undefined, 'the model key stays here');
  assert.deepEqual(Object.keys(tools()), [...['session_list', 'session_get_active', 'session_switch', 'session_read', 'session_close'], ...['kanban_screen', 'kanban_card_list', 'kanban_card_read', 'kanban_card_create', 'kanban_card_update', 'kanban_card_items', 'kanban_card_auto_plan', 'kanban_card_auto_build', 'kanban_card_pin', 'kanban_card_move', 'kanban_card_history'], 'workspace_create_repo', 'session_get_mode', 'screen_enter_plan_mode'], 'the brain was built with the TUI kit');
});

test('voice off: no pane, ctrl+g shows it anyway, /mic says voice is off', async () => {
  const { lastFrame, stdin } = appWithVoice({ voice_enabled: false, sidebar_width: 30 });
  await sleep(60);
  assert.doesNotMatch(strip(lastFrame() ?? ''), /voice · /);
  stdin.write('\x07'); await sleep(40);                          // ctrl+g
  assert.match(strip(lastFrame() ?? ''), /voice · off/);
  stdin.write('/mic'); await sleep(30); stdin.write('\r'); await sleep(60);
  assert.match(strip(lastFrame() ?? ''), /voice is off/);
});

// The sessions the SERVER holds. Only s1 is open in the window (`initial`),
// which is the whole point: a list built from the window's memory would say
// "one session" while the workspace holds these four.
const HOUR = 3_600_000;
const serverSessions = () => [
  { id: 's1', workspaceId: 'w1', branch: 'agent/s1', status: 'active',
    lastUsedAt: new Date().toISOString(), name: 'the one on screen', lastUserMessage: 'plan card 7' },
  { id: 's7', workspaceId: 'w1', branch: 'agent/s7', status: 'active', card: 7,
    lastUsedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
    name: 'auth redirect fix', lastUserMessage: '  fix   the login redirect\n' },
  { id: 's9', workspaceId: 'w1', branch: 'agent/s9', status: 'active', card: 9, agent: 'supervisor',
    lastUsedAt: new Date(Date.now() - 6 * HOUR).toISOString(), name: 'card 9 rounds',
    locked: true, lockedBy: 'another-window', lockedLabel: 'the looper' },
  { id: 'sD', workspaceId: 'w1', branch: 'agent/sD', status: 'destroyed',
    lastUsedAt: new Date(Date.now() - 40 * 24 * HOUR).toISOString(), name: 'swept last month' },
];
/** A server with sessions on it, and the calls it was asked for. */
const sessionsApi = (calls: string[] = []) => {
  let rows = serverSessions();
  return {
    calls,
    api: async (m: string, p: string, b?: unknown) => {
      calls.push(`${m} ${p}`);
      if (p === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'widgets', displayName: 'Widgets' }];
      if (p.split('?')[0] === '/sessions' && m === 'GET') {
        const q = new URLSearchParams(p.split('?')[1] ?? '');
        return { sessions: rows.slice(0, Number(q.get('limit') ?? rows.length)), total: rows.length };
      }
      // A restart: the destroyed row comes back active, as the server's does.
      if (p === '/sessions' && m === 'POST') {
        const id = (b as { id?: string }).id ?? 'sNEW';
        rows = rows.map((r) => (r.id === id ? { ...r, status: 'active' } : r));
        return { ...rows.find((r) => r.id === id), skills: [] };
      }
      if (p.endsWith('/transcript')) return { data: null };
      // An id nothing matches 404s, exactly as the real route does — the
      // fake must refuse what the server refuses or a bad id looks openable.
      if (p.startsWith('/sessions/')) {
        const hit = rows.find((r) => p === `/sessions/${r.id}`);
        if (!hit) throw new Error(`GET ${p}: not_found no such session`);
        return hit;
      }
      return {};
    },
  };
};

test('/assistant runs the brain; the reply is spoken and lands in the pane; session_list answers from the SERVER', async () => {
  const { api } = sessionsApi();
  const { lastFrame, stdin, f, tools } = appWithVoice({ voice_enabled: true, sidebar_width: 45, deepgram_api_key: 'dg', anthropic_api_key: 'k' }, scriptedAgent(), api as never);
  await sleep(80);
  f.emit(ready());
  stdin.write('/assistant which sessions are open'); await sleep(30); stdin.write('\r'); await sleep(120);
  assert.match(strip(lastFrame() ?? ''), /which sessions are open/, 'shown in the voice pane as yours');
  assert.equal(f.ofType('speak_delta').map((m) => m.text).join(''), 'Just one, s1.', 'spoken through the sidecar');
  assert.match(strip(lastFrame() ?? ''), /Just one, s1\./);
  const listTool = tools().session_list as { execute: (a: unknown, o: unknown) => Promise<{
    sessions: Record<string, unknown>[]; showing: string; more: boolean; on_screen: string }> };
  const res = await listTool.execute({}, { toolCallId: 'x', messages: [] });
  // EVERY session, not the one this window happens to hold.
  assert.deepEqual(res.sessions.map((s) => s.id), ['s1', 's7', 's9', 'sD']);
  assert.equal(res.more, false, 'a short page is the end');
  assert.equal(res.on_screen, 's1');
  // The row a person can act on: title, workspace by NAME, card, the last
  // message on one line, and no branch (it is the id wearing a prefix).
  assert.deepEqual(res.sessions[1], {
    id: 's7', name: 'auth redirect fix', workspace: 'Widgets', card: 7, kind: 'looper',
    status: 'active', running: false, on_screen: false,
    last_message: 'fix the login redirect', when: '3h',
  });
  assert.equal(res.sessions[0].on_screen, true, 'the window says which one you are looking at');
  // Running is the SERVER's lock, not this window's memory: a turn on another
  // machine reads as running here.
  assert.deepEqual(res.sessions.map((s) => [s.id, s.running]), [['s1', false], ['s7', false], ['s9', true], ['sD', false]]);
  assert.equal(res.sessions[2].kind, 'supervisor', "the looper's records are marked, not hidden");
  assert.deepEqual([res.sessions[3].status, res.sessions[3].when], ['ended', '6w']);
  // read still answers from the window: no id = the session on screen (whose
  // coding conversation is empty here — /assistant talks to the Assistant).
  const readTool = tools().session_read as { execute: (a: unknown, o: unknown) => Promise<unknown> };
  const read = await readTool.execute({}, { toolCallId: 'y', messages: [] }) as string;
  assert.equal(read, 'session s1 — the conversation is empty');
  // A session on the server but not open here: the error names the fix.
  const missing = await readTool.execute({ id: 's7' }, { toolCallId: 'z', messages: [] }) as { error: string };
  assert.match(missing.error, /s7 is not open in this window — session_switch opens it/);
});

test('session_list pages with offset/limit, and refuses to reach past the server list', async () => {
  const { api, calls } = sessionsApi();
  const { tools } = appWithVoice({ voice_enabled: true, deepgram_api_key: 'dg', anthropic_api_key: 'k' }, scriptedAgent(), api as never);
  await sleep(80);
  const list = tools().session_list as { execute: (a: unknown, o: unknown) => Promise<{
    sessions: { id: string }[]; showing: string; more: boolean; error?: string }> };
  const first = await list.execute({ limit: 2 }, { toolCallId: 'a', messages: [] });
  assert.deepEqual(first.sessions.map((s) => s.id), ['s1', 's7']);
  assert.equal(first.more, true, 'the lookahead row says there is genuinely more behind it');
  // offset skips the most recent — one request, the server does the ordering.
  const next = await list.execute({ limit: 2, offset: 2 }, { toolCallId: 'b', messages: [] });
  assert.deepEqual(next.sessions.map((s) => s.id), ['s9', 'sD']);
  assert.match(next.showing, /skipping the 2 most recent/);
  assert.equal(next.more, false);
  // One request per page, and one row past it — the lookahead that makes
  // `more` an answer rather than a guess.
  assert.ok(calls.includes('GET /sessions?limit=3'), 'the first page asks for limit + 1');
  assert.ok(calls.includes('GET /sessions?limit=5'), 'the second asks for offset + limit + 1');
  // Past the server's own cap: refused with the reason, never a 400 from a
  // request the endpoint would reject outright.
  const far = await list.execute({ limit: 50, offset: 500 }, { toolCallId: 'c', messages: [] });
  assert.match(String(far.error), /reaches 500 sessions back/);
  // Above the ceiling the page is clamped, not sent as asked.
  await list.execute({ limit: 999 }, { toolCallId: 'd', messages: [] });
  assert.ok(calls.includes('GET /sessions?limit=101'), 'limit is clamped to the ceiling (100)');
});

test('session_switch opens ANY session — one that was never loaded here, and a swept one it restarts', async () => {
  const { api, calls } = sessionsApi();
  const { tools } = appWithVoice({ voice_enabled: true, deepgram_api_key: 'dg', anthropic_api_key: 'k' }, scriptedAgent(), api as never);
  await sleep(80);
  const switchTool = tools().session_switch as { execute: (a: unknown, o: unknown) => Promise<{ ok?: boolean; on_screen?: string; error?: string }> };
  // s7 exists on the server and was never open in this window.
  const opened = await switchTool.execute({ id: 's7' }, { toolCallId: 'a', messages: [] });
  assert.deepEqual([opened.ok, opened.on_screen], [true, 's7']);
  // An ENDED session is restarted through the same one path — the POST that
  // re-claims its files, exactly what pressing enter on /resume does.
  const restarted = await switchTool.execute({ id: 'sD' }, { toolCallId: 'b', messages: [] });
  assert.deepEqual([restarted.ok, restarted.on_screen], [true, 'sD']);
  assert.ok(calls.includes('POST /sessions'), 'the swept session was restarted, not opened empty');
  // A partial id is NOT accepted: it used to match the first session whose id
  // started with it, which silently opened the wrong conversation.
  const partial = await switchTool.execute({ id: 's' }, { toolCallId: 'c', messages: [] });
  assert.match(String(partial.error), /could not open session s —/);
});

test('session_close closes by id or the session on screen, through the same path /close takes', async () => {
  const { api } = sessionsApi();
  const { tools } = appWithVoice({ voice_enabled: true, deepgram_api_key: 'dg', anthropic_api_key: 'k' }, scriptedAgent(), api as never);
  await sleep(80);
  const run = (name: string, a: unknown) => (tools()[name] as { execute: (a: unknown, o: unknown) => Promise<{
    ok?: boolean; closed?: string; on_screen?: string; opened_new?: boolean; error?: string }> })
    .execute(a, { toolCallId: 'x', messages: [] });
  // Three open here: s1 (the launch), s7, and s9 — now on screen.
  await run('session_switch', { id: 's7' });
  await run('session_switch', { id: 's9' });
  // By id, one NOT on screen: it leaves memory, the screen does not move.
  const byId = await run('session_close', { id: 's1' });
  assert.deepEqual(byId, { ok: true, closed: 's1', on_screen: 's9', opened_new: false });
  // No id: the one on screen goes, and the most recently used one takes over.
  const active = await run('session_close', {});
  assert.deepEqual(active, { ok: true, closed: 's9', on_screen: 's7', opened_new: false });
  // Gone from memory means gone: a second close, or an id never opened here,
  // is an error that says so — nothing on the server is touched.
  assert.match(String((await run('session_close', { id: 's1' })).error), /not open in this window/);
  assert.match(String((await run('session_read', { id: 's1' })).error), /not open in this window/);
});

test('/speaker toggles; the devices row shows it and the header keeps the state', async () => {
  const { lastFrame, stdin, f } = appWithVoice({ voice_enabled: true, sidebar_width: 45, deepgram_api_key: 'dg', anthropic_api_key: 'k' });
  await sleep(80);
  f.emit(ready());
  await sleep(40);
  assert.match(strip(lastFrame() ?? ''), /● mic · ● speaker/, 'both on');
  stdin.write('/speaker'); await sleep(30); stdin.write('\r'); await sleep(60);
  assert.deepEqual(f.sent.at(-1), { type: 'speaker', muted: true });
  const frame = strip(lastFrame() ?? '');
  assert.match(frame, /● mic · ⊘ speaker/, 'the speaker is the muted glyph');
  assert.match(frame, /voice · listening/, 'the status word stays');
  // The sidecar's word wins (headphones off: it mutes the mic while it speaks).
  f.emit({ type: 'status', mic_muted: true }); await sleep(40);
  assert.match(strip(lastFrame() ?? ''), /⊘ mic · ⊘ speaker/);
});

test('a click on the devices row toggles — mic on `● mic`, speaker on `● speaker`, drag does not', async () => {
  const sgr = (code: number, x: number, y: number, release = false) =>
    `\x1b[<${code};${x + 1};${y + 1}${release ? 'm' : 'M'}`;
  const { lastFrame, stdin, f } = appWithVoice({ voice_enabled: true, sidebar_width: 45, deepgram_api_key: 'dg', anthropic_api_key: 'k' });
  await sleep(80);
  f.emit(ready());
  await sleep(40);
  const lines = strip(lastFrame() ?? '').split('\n');
  const y = lines.findIndex((l) => l.includes('● mic'));
  const micX = lines[y]!.indexOf('● mic');
  const spkX = lines[y]!.indexOf('● speaker');
  stdin.write(sgr(0, micX, y)); await sleep(20);
  stdin.write(sgr(0, micX, y, true)); await sleep(40);
  assert.deepEqual(f.sent.at(-1), { type: 'mic', muted: true });
  assert.match(strip(lastFrame() ?? ''), /⊘ mic · ● speaker/, 'the glyph flips');
  stdin.write(sgr(0, spkX, y)); await sleep(20);
  stdin.write(sgr(0, spkX, y, true)); await sleep(40);
  assert.deepEqual(f.sent.at(-1), { type: 'speaker', muted: true });
  // A drag that starts on the row is a text selection, not a toggle.
  const before = f.sent.length;
  stdin.write(sgr(0, spkX, y)); await sleep(20);
  stdin.write(sgr(32, spkX + 4, y)); await sleep(20);
  stdin.write(sgr(0, spkX + 4, y, true)); await sleep(40);
  assert.equal(f.sent.length, before, 'a drag toggles nothing');
});

test('the mutes are saved: they ride the spawn env, ready restores them, and a toggle writes the file', async () => {
  const { lastFrame, stdin, f, configPath } = appWithVoice({
    voice_enabled: true, sidebar_width: 45, deepgram_api_key: 'dg', anthropic_api_key: 'k', voice_mic_muted: true,
  });
  await sleep(80);
  assert.equal(f.env().PHANTOM_CLI_VOICE_MIC_MUTED, '1', 'the saved mute rides the spawn env');
  f.emit({ type: 'ready', devices: { mics: [], speakers: [] }, mic: '', speaker: '', voice: 'v', mic_muted: true, speaker_muted: false });
  await sleep(40);
  assert.match(strip(lastFrame() ?? ''), /⊘ mic · ● speaker/, 'restored muted');
  stdin.write('/mic'); await sleep(30); stdin.write('\r'); await sleep(60);
  assert.deepEqual(f.sent.at(-1), { type: 'mic', muted: false });
  assert.equal(localValues(configPath).voice_mic_muted, false, 'written back to the file');
  stdin.write('/speaker'); await sleep(30); stdin.write('\r'); await sleep(60);
  assert.deepEqual(f.sent.at(-1), { type: 'speaker', muted: true });
  assert.equal(localValues(configPath).voice_speaker_muted, true);
});

test('ready and status carry the modes; the engine\'s word wins', async () => {
  const f = fakeSidecar();
  const v = new VoiceClient(f.spawner, null);
  await v.start({});
  f.emit({ type: 'ready', devices: { mics: [], speakers: [] }, mic: '', speaker: '', voice: 'v', headphones: true, wake: false });
  assert.equal(v.snapshot().headphones, true);
  assert.equal(v.snapshot().wake, false);
  f.emit({ type: 'status', wake: true });
  assert.equal(v.snapshot().wake, true);
});

test('the awake window rides status: awake_secs sets the deadline, the lapse clears it, ready re-gates', async () => {
  const f = fakeSidecar();
  const v = new VoiceClient(f.spawner, null);
  await v.start({});
  f.emit(ready());
  assert.equal(v.snapshot().awake, false);
  assert.equal(v.snapshot().awakeUntil, null);
  const t0 = Date.now();
  f.emit({ type: 'status', awake: true, awake_secs: 8 });
  assert.equal(v.snapshot().awake, true);
  const until = v.snapshot().awakeUntil;
  assert.ok(until !== null && until >= t0 + 7900 && until <= Date.now() + 8000, 'deadline ≈ now + 8s');
  // Activity pushes the deadline forward; a status without awake_secs keeps it.
  f.emit({ type: 'status', awake: true });
  assert.equal(v.snapshot().awakeUntil, until, 'no awake_secs — the deadline stands');
  f.emit({ type: 'status', awake: false });
  assert.equal(v.snapshot().awake, false);
  assert.equal(v.snapshot().awakeUntil, null, 'lapsed — nothing to count down to');
  f.emit({ type: 'status', awake: true, awake_secs: 8 });
  f.emit(ready());
  assert.equal(v.snapshot().awake, false, 'a fresh engine starts gated');
  assert.equal(v.snapshot().awakeUntil, null);
});

test('the lapse clears the forming line: speech the wake gate refused must not sit on the pane', async () => {
  const f = fakeSidecar();
  const v = new VoiceClient(f.spawner, null);
  await v.start({});
  f.emit(ready());
  f.emit({ type: 'status', awake: true, awake_secs: 8 });
  f.emit({ type: 'user', text: 'so anyway', final: false });
  assert.equal((v.snapshot().live[0] as { text: string }).text, 'so anyway');
  f.emit({ type: 'status', awake: false });
  assert.equal(v.snapshot().live.length, 0, 'no turn is coming for it — the line goes with the window');
});

test('while awake the wake switch is a yellow active mark with the countdown — ● active Ns — and back to ● wake on the lapse', async () => {
  const { lastFrame, stdin, f } = appWithVoice({ voice_enabled: true, sidebar_width: 45, deepgram_api_key: 'dg', anthropic_api_key: 'k' });
  await sleep(80);
  f.emit(ready());
  await sleep(40);
  stdin.write('/wake'); await sleep(30); stdin.write('\r'); await sleep(60);
  assert.match(strip(lastFrame() ?? ''), /● wake · [●⊘] headphones/, 'on, gated — no mark yet');
  f.emit({ type: 'status', awake: true, awake_secs: 8 });
  await sleep(40);
  assert.match(strip(lastFrame() ?? ''), /● active [78]s/, 'the window is open and counting');
  assert.match(lastFrame() ?? '', /\x1b\[33m● active/, 'the active mark is yellow');
  f.emit({ type: 'status', awake: false });
  await sleep(40);
  assert.match(strip(lastFrame() ?? ''), /● wake · [●⊘] headphones/, 'the lapse is visible at once');
});

test('/headphones and /wake flip the setting and push it live — no engine restart — and clicks on the modes row do the same', async () => {
  const sgr = (code: number, x: number, y: number, release = false) =>
    `\x1b[<${code};${x + 1};${y + 1}${release ? 'm' : 'M'}`;
  const { lastFrame, stdin, f, configPath } = appWithVoice({ voice_enabled: true, sidebar_width: 45, deepgram_api_key: 'dg', anthropic_api_key: 'k' });
  await sleep(80);
  f.emit(ready());
  await sleep(40);
  assert.match(strip(lastFrame() ?? ''), /⊘ wake · ⊘ headphones/, 'both off — the defaults');
  stdin.write('/headphones'); await sleep(30); stdin.write('\r'); await sleep(60);
  assert.deepEqual(f.sent.at(-1), { type: 'set', headphones: true }, 'pushed live, not a restart');
  assert.equal(localValues(configPath).voice_headphones, true, 'written to the settings file');
  assert.match(strip(lastFrame() ?? ''), /⊘ wake · ● headphones/);
  stdin.write('/wake'); await sleep(30); stdin.write('\r'); await sleep(60);
  assert.deepEqual(f.sent.at(-1), { type: 'set', wake: true, wake_words: 'computer', wake_timeout: 8 });
  // The wake word is not a fact about this machine, so it is saved on the
  // server — the switch itself works the same either way.
  assert.match(strip(lastFrame() ?? ''), /● wake · ● headphones/);
  assert.equal(f.spawns(), 1, 'the sidecar was never restarted');
  // Clicks on the modes row are the same toggles, back off again.
  const lines = strip(lastFrame() ?? '').split('\n');
  const y = lines.findIndex((l) => l.includes('● headphones'));
  const hpX = lines[y]!.indexOf('● headphones');
  const wakeX = lines[y]!.indexOf('● wake');
  stdin.write(sgr(0, hpX, y)); await sleep(20);
  stdin.write(sgr(0, hpX, y, true)); await sleep(60);
  assert.deepEqual(f.sent.at(-1), { type: 'set', headphones: false });
  assert.equal(localValues(configPath).voice_headphones, false);
  stdin.write(sgr(0, wakeX, y)); await sleep(20);
  stdin.write(sgr(0, wakeX, y, true)); await sleep(60);
  assert.deepEqual(f.sent.at(-1), { type: 'set', wake: false, wake_words: 'computer', wake_timeout: 8 });
  assert.match(strip(lastFrame() ?? ''), /⊘ wake · ⊘ headphones/);
  assert.equal(f.spawns(), 1, 'still the first engine');
});

test('the ttfb row is behind ctrl+o', async () => {
  const { lastFrame, stdin, f } = appWithVoice({ voice_enabled: true, sidebar_width: 45, deepgram_api_key: 'dg', anthropic_api_key: 'k' });
  await sleep(80);
  f.emit(ready());
  f.emit({ type: 'metrics', processor: 'DeepgramSTTService#0', ttfb_ms: 210 });
  f.emit({ type: 'metrics', processor: 'llm', ttfb_ms: 480 });
  await sleep(40);
  assert.doesNotMatch(strip(lastFrame() ?? ''), /480ms/, 'tuning output, not day-to-day');
  stdin.write('\x0f'); await sleep(40);                         // ctrl+o
  assert.match(strip(lastFrame() ?? ''), /dg STT 210ms · llm 480ms/);
  stdin.write('\x0f'); await sleep(40);
  assert.doesNotMatch(strip(lastFrame() ?? ''), /480ms/);
});

test('the divider is one heavy bar with junctions where the prompt rules meet it, following the prompt', async () => {
  const { lastFrame, stdin } = appWithVoice({ voice_enabled: true, sidebar_width: 30, deepgram_api_key: 'dg', anthropic_api_key: 'k' });
  await sleep(80);
  // The divider's column: where the bar is on the first row.
  const x = [...strip(lastFrame() ?? '').split('\n')[0]!].indexOf('┃');
  assert.ok(x > 0, 'a bar on the first row');
  const col = (frame: string) => frame.split('\n').map((l) => [...l][x] ?? ' ');
  let bars = col(strip(lastFrame() ?? ''));
  assert.equal(bars.length, 24);
  assert.ok(bars.every((c) => c === '┃' || c === '┫'), `all bar: ${bars.join('')}`);
  // Prompt pinned at the bottom. The mode mark ('» code mode on') keeps one
  // toolbar row under the prompt at all times, so the rules sit one row up.
  assert.deepEqual(bars.map((c, i) => (c === '┫' ? i : -1)).filter((i) => i >= 0), [20, 22]);
  // ctrl+c's arming joins that same row (composed after the mode mark) rather
  // than adding one: the junctions hold still.
  stdin.write('\x03');
  await sleep(40);
  bars = col(strip(lastFrame() ?? ''));
  assert.deepEqual(bars.map((c, i) => (c === '┫' ? i : -1)).filter((i) => i >= 0), [20, 22]);
});

test('the kanban tool drives the UI: open puts the board on screen, an edit repaints it, close returns to chat', async () => {
  const cards = [{ id: 1, seq: 1, status: 'backlog', pos: 1, title: 'voice card', details: '', user_story: '',
    requirements: [], blocked_reason: null, archived: false,
    created_at: 'x', updated_at: 'x' }];
  const api = async (method: string, path: string, body?: unknown) => {
    if (method === 'GET' && path.startsWith('/workspaces/w1/cards'))
      return { prefix: 'PHA', columns: ['backlog', 'doing', 'done'], cards };
    if (method === 'PATCH') { Object.assign(cards[0], body); return { card: cards[0] }; }
    return {};
  };
  const { lastFrame, tools } = appWithVoice(
    { voice_enabled: true, sidebar_width: 30, deepgram_api_key: 'dg', anthropic_api_key: 'k' }, scriptedAgent(), api as never);
  await sleep(80);
  const t = (name: string) => tools()[name] as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> };
  assert.ok(t('kanban_screen'), 'the screen tool is in the kit');
  await t('kanban_screen').execute({ show: 'board' }, {});
  await sleep(60);
  let f = strip(lastFrame() ?? '');
  assert.match(f, /backlog \(1\)/, 'open puts the board on screen');
  assert.match(f, /1-voice card/);
  await t('kanban_card_update').execute({ card: 1, status: 'done' }, {});
  await sleep(60);
  f = strip(lastFrame() ?? '');
  assert.match(f, /done \(1\)/, 'a tool edit repaints the open board');
  await t('kanban_screen').execute({ show: 'off' }, {});
  await sleep(60);
  f = strip(lastFrame() ?? '');
  assert.match(f, /type a message/, 'off returns to the chat');
  // "show card 1": board comes up WITH that card's edit screen.
  const opened = await t('kanban_screen').execute({ show: 'card', card: 1 }, {}) as { screen?: string };
  await sleep(80);
  f = strip(lastFrame() ?? '');
  assert.match(f, /PHA-1/, 'the card is open');
  assert.match(f, /\[ctrl\+e\] tick/, 'as its edit screen');
  assert.match(String(opened.screen), /card 1/);
  // back to the board: the edit screen drops, the BOARD stays — not the chat.
  const closedCard = await t('kanban_screen').execute({ show: 'board' }, {}) as { screen?: string };
  await sleep(60);
  f = strip(lastFrame() ?? '');
  assert.ok(!f.includes('[ctrl+e] tick'), 'the edit screen is gone');
  assert.match(f, /backlog \(/, 'the board is still up');
  assert.equal(closedCard.screen, 'board');
  const closedAll = await t('kanban_screen').execute({ show: 'off' }, {}) as { screen?: string };
  await sleep(60);
  assert.ok(!strip(lastFrame() ?? '').includes('backlog ('), 'off leaves the board');
  assert.equal(closedAll.screen, 'chat');
  const missing = await t('kanban_screen').execute({ show: 'card', card: 99 }, {}) as { error?: string };
  assert.match(String(missing.error), /no card 99/);
  // "expand the doing column" from CHAT: the board comes up with that one
  // column across the width, and the result says so. A spoken name is
  // forgiven the way a move's is.
  const expanded = await t('kanban_screen').execute({ show: 'column', column: 'Doing' }, {}) as { screen?: string };
  await sleep(80);
  f = strip(lastFrame() ?? '');
  assert.match(f, /doing \(0\)/, 'the asked-for column is on screen');
  assert.ok(!f.includes('backlog ('), 'alone — the others left');
  assert.match(f, /\[e\] collapse/, 'the footer says it is expanded');
  assert.equal(expanded.screen, 'column doing, expanded');
  // "show the board" puts every column back.
  const all = await t('kanban_screen').execute({ show: 'board' }, {}) as { screen?: string };
  await sleep(60);
  f = strip(lastFrame() ?? '');
  assert.match(f, /backlog \(/); assert.match(f, /doing \(/);
  assert.equal(all.screen, 'board');
  const noCol = await t('kanban_screen').execute({ show: 'column', column: 'nope' }, {}) as { error?: string };
  assert.match(String(noCol.error), /no column "nope" — the columns are: backlog, doing, done/);
  const noName = await t('kanban_screen').execute({ show: 'column' }, {}) as { error?: string };
  assert.match(String(noName.error), /needs the column name/);
});

test('the Assistant carries read-only workspace tools for the session on screen', async () => {
  const fakeRead = { description: 'read a file', inputSchema: { jsonSchema: { type: 'object' } }, execute: async () => 'x' } as unknown as Tool;
  const asked: string[] = [];
  const { tools } = appWithVoice(
    { voice_enabled: true, sidebar_width: 30, deepgram_api_key: 'dg', anthropic_api_key: 'k' },
    scriptedAgent(), noApi, async (id) => { asked.push(id); return { read: fakeRead }; });
  await sleep(80);
  assert.deepEqual(Object.keys(tools()), [...['session_list', 'session_get_active', 'session_switch', 'session_read', 'session_close'], ...['kanban_screen', 'kanban_card_list', 'kanban_card_read', 'kanban_card_create', 'kanban_card_update', 'kanban_card_items', 'kanban_card_auto_plan', 'kanban_card_auto_build', 'kanban_card_pin', 'kanban_card_move', 'kanban_card_history'], 'workspace_create_repo', 'session_get_mode', 'screen_enter_plan_mode', 'read'], 'the kit is TUI tools + the readonly set');
  assert.deepEqual(asked, ['s1'], 'scoped to the session on screen');
});

test('the Assistant carries the screen_* tools: mode read live, plan entered one-way, for the session on screen', async () => {
  const calls: string[] = [];
  // The session ROW — plan_mode lives there, the PATCH moves it, and the tool
  // reads it back from there.
  const row = { planMode: false };
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`);
    if (method === 'PATCH' && path === '/sessions/s1'
      && typeof (body as { plan_mode?: boolean })?.plan_mode === 'boolean') {
      row.planMode = (body as { plan_mode: boolean }).plan_mode;
    }
    if (method === 'GET' && path === '/sessions/s1') return { ...row };
    return {};
  };
  const { tools } = appWithVoice(
    { voice_enabled: true, sidebar_width: 30, deepgram_api_key: 'dg', anthropic_api_key: 'k' },
    scriptedAgent(), api as never);
  await sleep(80);
  const t = (name: string) => tools()[name] as unknown as
    { execute: (a: unknown, o: unknown) => Promise<unknown> };
  assert.deepEqual(await t('session_get_mode').execute({}, {}), { mode: 'code' });
  assert.deepEqual(await t('screen_enter_plan_mode').execute({}, {}), { ok: true });
  assert.ok(calls.includes('PATCH /sessions/s1 {"plan_mode":true}'), 'the row is the record');
  // The Assistant's kit is NOT rebuilt on the flip — its handler reads the
  // store live, so the same tool now reports the new mode.
  assert.deepEqual(await t('session_get_mode').execute({}, {}), { mode: 'plan' });
  assert.deepEqual(await t('screen_enter_plan_mode').execute({}, {}),
    { ok: false, error: 'already in plan mode' });
});

test('session_get_active names the session on screen in ONE call — no session_list page', async () => {
  const calls: string[] = [];
  const api = async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    if (path === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'widgets', displayName: 'Widgets' }];
    if (method === 'GET' && path === '/sessions/s1') {
      return { id: 's1', name: 'the titler', workspaceId: 'w1', card: 7, status: 'active', planMode: false };
    }
    return {};
  };
  const { tools } = appWithVoice(
    { voice_enabled: true, sidebar_width: 30, deepgram_api_key: 'dg', anthropic_api_key: 'k' },
    scriptedAgent(), api as never);
  await sleep(80);
  const t = (name: string) => tools()[name] as unknown as
    { execute: (a: unknown, o: unknown) => Promise<unknown> };
  calls.length = 0;
  assert.deepEqual(await t('session_get_active').execute({}, {}), {
    id: 's1', title: 'the titler', workspace: 'Widgets', card: 7, status: 'active', running: false,
  }, 'the session on screen, named the way a person would say it');
  // The point of the tool: the whole list is no longer the price of one field.
  assert.ok(!calls.some((c) => c.startsWith('GET /sessions?')), 'no session_list page was fetched');
  assert.ok(calls.includes('GET /sessions/s1'), 'one row, the one on screen');
});

// ── workspace_create_repo and the approval gate ──────────────────────────────

test('kebabName: the spoken name becomes the repo name deterministically', () => {
  assert.equal(kebabName('Phantom Viewer'), 'phantom-viewer');
  assert.equal(kebabName("  My App's  2.0! "), 'my-app-s-2-0');
  assert.equal(kebabName('---'), '');
});

test("workspace_create_repo is gated: the ask sits in the Assistant's pane, the chat prompt stays live; clicking decline creates nothing, accept creates and the new workspace opens on screen", async () => {
  const sgr = (code: number, x: number, y: number, release = false) =>
    `\x1b[<${code};${x + 1};${y + 1}${release ? 'm' : 'M'}`;
  const calls: Array<[string, string, unknown]> = [];
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push([method, path, body]);
    if (method === 'POST' && path === '/workspaces') return { id: 'w2', owner: 'acme', name: 'phantom-viewer' };
    if (method === 'POST' && path.split('?')[0] === '/sessions') return { id: 's2', workspaceId: 'w2', branch: 'agent/s2', status: 'active', skills: [] };
    if (path === '/sessions/s2/transcript') return { data: null };
    if (path === '/workspaces/w2') return { name: 'phantom-viewer' };
    return {};
  };
  const { lastFrame, stdin, tools } = appWithVoice(
    { voice_enabled: true, sidebar_width: 45, deepgram_api_key: 'dg', anthropic_api_key: 'k' }, scriptedAgent(), api as never);
  await sleep(80);
  const t = tools().workspace_create_repo as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> };
  assert.ok(t, 'the gated tool is in the kit');
  const clickAnswer = async (word: 'accept' | 'decline') => {
    const lines = strip(lastFrame() ?? '').split('\n');
    const y = lines.findIndex((l) => l.includes('accept · decline'));
    assert.ok(y >= 0, 'the answers row is on screen');
    const x = lines[y]!.indexOf(word);
    stdin.write(sgr(0, x, y)); await sleep(20);
    stdin.write(sgr(0, x, y, true)); await sleep(20);
  };

  // Decline: the ask was up in the pane, the chat prompt never locked, and
  // nothing reached the server.
  let pending = t.execute({ name: 'Phantom Viewer' }, { toolCallId: 'c1', messages: [] });
  await sleep(40);
  const frame = strip(lastFrame() ?? '');
  assert.match(frame, /new private repo\?/, "the ask is the Assistant's, in its pane");
  assert.match(frame, /phantom-viewer/, 'the kebab-cased FINAL name, on its own row');
  assert.match(frame, /accept · decline/);
  assert.match(frame, /type a message/, 'the chat prompt stays live — nothing modal');
  {
    const lines = frame.split('\n');
    const answersY = lines.findIndex((l) => l.includes('accept · decline'));
    assert.ok(answersY >= lines.length - 3, `the ask sits under the chat, at the pane's tail (row ${answersY} of ${lines.length})`);
  }
  await clickAnswer('decline');
  const declined = await pending as { declined?: boolean };
  assert.equal(declined.declined, true);
  assert.ok(!calls.some(([m, p]) => m === 'POST' && p === '/workspaces'), 'declined: nothing was created');
  await sleep(20);
  assert.ok(!strip(lastFrame() ?? '').includes('accept · decline'), 'answered: the ask leaves the pane');

  // Accept: created private, description along, and the session lands on screen.
  pending = t.execute({ name: 'Phantom Viewer', description: 'a viewer' }, { toolCallId: 'c2', messages: [] });
  await sleep(40);
  await clickAnswer('accept');
  const ok = await pending as { ok?: boolean; repo?: string; on_screen?: string };
  assert.equal(ok.ok, true);
  assert.equal(ok.repo, 'acme/phantom-viewer');
  const create = calls.find(([m, p]) => m === 'POST' && p === '/workspaces');
  assert.deepEqual(create?.[2], { url: 'phantom-viewer', create: true, private: true, description: 'a viewer' });
  assert.match(String(ok.on_screen), /new session in the new workspace/);
  await sleep(60);
  assert.match(strip(lastFrame() ?? ''), /phantom-viewer · agent\/s2/, "the new workspace's session is on screen");
});

test('spoken words answer the approval: anything else is swallowed while it stands, the exact word acts, and an aborted call declines', async () => {
  const calls: string[] = [];
  const api = async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    if (method === 'POST' && path === '/workspaces') return { id: 'w2', owner: 'acme', name: 'demo' };
    if (method === 'POST' && path.split('?')[0] === '/sessions') return { id: 's2', workspaceId: 'w2', branch: 'agent/s2', status: 'active', skills: [] };
    if (path === '/sessions/s2/transcript') return { data: null };
    return {};
  };
  const { f, tools, voice } = appWithVoice(
    { voice_enabled: true, sidebar_width: 30, deepgram_api_key: 'dg', anthropic_api_key: 'k' }, scriptedAgent(), api as never);
  await sleep(80);
  f.emit(ready());
  const t = tools().workspace_create_repo as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> };
  const pending = t.execute({ name: 'demo' }, { toolCallId: 'c1', messages: [] });
  await sleep(40);
  const starts = f.ofType('speak_start').length;
  f.emit({ type: 'turn', text: 'what was that?' });   // not an answer — swallowed, the brain does not run
  await sleep(40);
  assert.equal(f.ofType('speak_start').length, starts, 'swallowed: no brain turn started');
  assert.equal(voice.history.length, 0, 'and nothing entered the conversation');
  f.emit({ type: 'turn', text: 'Accept.' });          // case and punctuation forgiven; the word is exact
  const ok = await pending as { ok?: boolean };
  assert.equal(ok.ok, true);
  assert.ok(calls.includes('POST /workspaces'));
  // The call dying (the user cut the Assistant off) declines — the prompt
  // cannot outlive the tool call that asked for it.
  const ac = new AbortController();
  const p2 = t.execute({ name: 'demo two' }, { toolCallId: 'c2', messages: [], abortSignal: ac.signal });
  await sleep(30);
  ac.abort();
  const dead = await p2 as { declined?: boolean };
  assert.equal(dead.declined, true);
});
