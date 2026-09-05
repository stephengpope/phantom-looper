// The Assistant as the TUI sees it. Three things, one file:
//
//   1. the process — `sidecar/bot.py` (pipecat, Python) run through uv: the
//      ears and the mouth. Mic, speaker, voice detection, wake word, echo
//      suppression, speech-to-text, text-to-speech, turn-taking. No model, no
//      keys but Deepgram's. The TUI finds uv (or downloads it into
//      ~/.phantom-cli/bin), builds the venv once, spawns the bot with its config
//      in the environment, and kills the whole process group on stop.
//   2. the wire — one JSON object per line on the child's stdin/stdout
//      (sidecar/protocol.py is the other end). The sidecar says `turn` when you
//      have finished talking; we answer with `speak_*` text as the model writes
//      it; it says `interrupted` when you cut in and `spoken` with what was
//      actually said out loud, so the history can hold that and not the rest.
//   3. the brain — the Assistant itself, an AI SDK agent built by
//      core/llm/createAgent exactly like the coding agent (agentFromConfig.
//      buildAssistantAgent): its own prompt, its own history, the `session_*` tools.
//      Run here, in this process, with runTurn; the pane shows the same `Part`s
//      the conversation renders. In memory only; appended to a per-day file as
//      it goes, never loaded back (a restart is a fresh conversation).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { ModelMessage } from 'ai';
import { CONFIG_DIR, type ConfigKey, type ConfigValue } from './config.js';
import { applyPart, finalize, nextId, takeCompleted, type Part, type StreamPart } from './state.js';
import { FLUSH_MS, runTurn, type Agent } from './agent.js';
import { Transcript } from '../core/llm/transcript.js';
import { assistantInstructions } from '../core/llm/agents/assistant.js';

export const SIDECAR_DIR = fileURLToPath(new URL('./sidecar/', import.meta.url));
export const VOICE_DIR = join(CONFIG_DIR, 'voice');
const UV_VERSION = '0.11.2';

// --- the wire -----------------------------------------------------------------

/** What we send. */
export type VoiceOut =
  | { type: 'speak_start'; turn: string; step: number }
  | { type: 'speak_delta'; turn: string; text: string }
  | { type: 'speak_end'; turn: string }
  | { type: 'mic'; muted: boolean }
  | { type: 'speaker'; muted: boolean }
  | { type: 'set'; voice?: string; wake?: boolean; wake_words?: string; wake_timeout?: number; headphones?: boolean }
  | { type: 'cancel' }
  | { type: 'devices' }
  | { type: 'shutdown' };

/** What the sidecar sends. */
export type VoiceIn =
  | { type: 'ready'; devices: { mics: string[]; speakers: string[] }; mic: string; speaker: string; voice: string; mic_muted?: boolean; speaker_muted?: boolean; headphones?: boolean; wake?: boolean }
  | { type: 'status'; speaking?: boolean; hearing?: boolean; mic_muted?: boolean; speaker_muted?: boolean; headphones?: boolean; wake?: boolean; awake?: boolean; awake_secs?: number }
  /** The transcript as it forms — for the pane, not the brain. */
  | { type: 'user'; text: string; final: boolean }
  /** You finished talking: this is what you said, as one turn. The brain runs. */
  | { type: 'turn'; text: string }
  /** You cut in (or /cancel): whatever is generating or being said stops now. */
  | { type: 'interrupted'; turn?: string }
  /** What was actually said out loud for one speak_start..speak_end, once it
   *  has been said — in full, or cut short (`interrupted`). */
  | { type: 'spoken'; turn: string; step: number; text: string; interrupted: boolean }
  | { type: 'metrics'; processor: string; ttfb_ms: number }
  | { type: 'devices'; devices: { mics: string[]; speakers: string[] } }
  /** Deepgram unreachable for over 5 s, and again when it is back — one line
   *  in the pane each, never one per attempt; the status is untouched.
   *  `error` is the engine giving up. */
  | { type: 'warn'; message: string }
  | { type: 'error'; message: string };

// --- the process --------------------------------------------------------------

/** A running sidecar, as the client needs it. The real one is a child process;
 *  tests hand in a scripted one. */
export interface SidecarProcess {
  send(line: string): void;
  kill(): void;
}
export type Spawner = (
  env: Record<string, string>,
  onLine: (line: string) => void,
  onExit: (code: number | null, detail?: string) => void,
  onProgress: (text: string) => void,
) => Promise<SidecarProcess>;

function log(text: string): void {
  try {
    mkdirSync(VOICE_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(join(VOICE_DIR, 'sidecar.log'), text.endsWith('\n') ? text : `${text}\n`);
  } catch { /* logging must never take the agent down */ }
}

/** uv, wherever it already is; `null` if nowhere. */
export function findUv(): string | null {
  const candidates = [
    join(CONFIG_DIR, 'bin', 'uv'),
    join(homedir(), '.local', 'bin', 'uv'),
    '/opt/homebrew/bin/uv', '/usr/local/bin/uv',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  const r = spawnSync('uv', ['--version'], { stdio: 'ignore' });
  return r.status === 0 ? 'uv' : null;
}

function uvTarget(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
  if (!arch) throw new Error(`no uv build for ${process.arch}`);
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  if (process.platform === 'linux') return `${arch}-unknown-linux-gnu`;
  throw new Error(`voice is not supported on ${process.platform} yet`);
}

/** Download the pinned uv into ~/.phantom-cli/bin, checking its published
 *  sha256. One-time, ~30 MB; nothing system-wide is touched. */
export async function installUv(onProgress: (t: string) => void): Promise<string> {
  const target = uvTarget();
  const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${target}.tar.gz`;
  onProgress(`downloading uv ${UV_VERSION}…`);
  const [tgz, sha] = await Promise.all([
    fetch(base).then(async (r) => { if (!r.ok) throw new Error(`uv download: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); }),
    fetch(`${base}.sha256`).then(async (r) => { if (!r.ok) throw new Error(`uv checksum: HTTP ${r.status}`); return (await r.text()).trim().split(/\s+/)[0]; }),
  ]);
  const got = createHash('sha256').update(tgz).digest('hex');
  if (got !== sha) throw new Error('uv download did not match its checksum — not installed');
  const dir = join(CONFIG_DIR, 'bin');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `uv-${target}.tar.gz`);
  writeFileSync(tmp, tgz);
  const r = spawnSync('tar', ['-xzf', tmp, '-C', dir, '--strip-components=1', `uv-${target}/uv`], { stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`uv unpack failed: ${r.stderr?.toString() ?? r.status}`);
  const uv = join(dir, 'uv');
  chmodSync(uv, 0o755);
  onProgress(`uv ${UV_VERSION} installed`);
  return uv;
}

/** The real spawner: uv → venv → `uv run bot.py`, process group of its own. */
export const spawnSidecar: Spawner = async (env, onLine, onExit, onProgress) => {
  let uv = findUv();
  if (!uv) uv = await installUv(onProgress);
  // `uv sync --frozen` every start: the first time it builds the venv (slow,
  // says so); after that it is a ~100ms check that the venv still matches
  // uv.lock, so an updated lock is picked up without anyone knowing to re-sync.
  if (!existsSync(join(SIDECAR_DIR, '.venv'))) onProgress('installing the voice engine (first time only)…');
  const sync = spawnSync(uv, ['sync', '--frozen'], { cwd: SIDECAR_DIR, stdio: 'pipe' });
  log(sync.stdout?.toString() ?? ''); log(sync.stderr?.toString() ?? '');
  if (sync.status !== 0) throw new Error(`uv sync failed — see ${join(VOICE_DIR, 'sidecar.log')}`);
  log(`--- sidecar start ${new Date().toISOString()}`);
  const child: ChildProcess = spawn(uv, ['run', '--no-sync', 'bot.py'], {
    cwd: SIDECAR_DIR, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  createInterface({ input: child.stdout! }).on('line', onLine);
  createInterface({ input: child.stderr! }).on('line', (l) => log(l));
  let exited = false;
  child.on('exit', (code, signal) => { exited = true; log(`--- sidecar exited ${code ?? signal}`); onExit(code, signal ?? undefined); });
  child.on('error', (e) => { exited = true; log(`--- sidecar error ${e.message}`); onExit(null, e.message); });
  return {
    send: (line) => { if (!exited) child.stdin?.write(line); },
    kill: () => {
      if (exited || !child.pid) return;
      try { child.stdin?.end(); } catch { /* gone */ }
      const pid = child.pid;
      try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
    },
  };
};

/** The mic and speaker names, without starting the sidecar: `uv run devices.py`
 *  (a second or two — PyAudio loading). Empty lists when uv or the venv is not
 *  there yet; the pickers then accept a typed name and the real list arrives
 *  with `ready` once the sidecar runs. */
export async function listDevices(): Promise<{ mics: string[]; speakers: string[] }> {
  const none = { mics: [], speakers: [] };
  const uv = findUv();
  if (!uv || !existsSync(join(SIDECAR_DIR, '.venv'))) return none;
  return new Promise((resolve) => {
    const child = spawn(uv, ['run', '--no-sync', 'devices.py'], { cwd: SIDECAR_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => log(b.toString()));
    child.on('error', () => resolve(none));
    child.on('exit', () => {
      try {
        const line = out.split('\n').find((l) => l.trim().startsWith('{'));
        const d = line ? JSON.parse(line) as { mics?: unknown; speakers?: unknown } : {};
        resolve({ mics: Array.isArray(d.mics) ? d.mics.map(String) : [], speakers: Array.isArray(d.speakers) ? d.speakers.map(String) : [] });
      } catch { resolve(none); }
    });
  });
}

// --- the environment the bot reads --------------------------------------------

/** Config → the sidecar's environment: the audio side only. The Deepgram key
 *  rides here and nowhere else; the model and its key never leave this
 *  process (the brain runs here). */
export function sidecarEnv(cfg: Record<string, ConfigValue>): Record<string, string> {
  const s = (v: ConfigValue) => (v === null || v === undefined ? '' : String(v));
  return {
    DEEPGRAM_API_KEY: s(cfg.deepgram_api_key),
    PHANTOM_CLI_VOICE_VOICE: s(cfg.voice_spoken_voice),
    PHANTOM_CLI_VOICE_MIC: s(cfg.voice_mic_device),
    PHANTOM_CLI_VOICE_SPEAKER: s(cfg.voice_speaker_device),
    PHANTOM_CLI_VOICE_STT_MODEL: s(cfg.voice_stt_model),
    PHANTOM_CLI_VOICE_MIC_MUTED: cfg.voice_mic_muted ? '1' : '0',
    PHANTOM_CLI_VOICE_SPEAKER_MUTED: cfg.voice_speaker_muted ? '1' : '0',
    PHANTOM_CLI_VOICE_HEADPHONES: cfg.voice_headphones ? '1' : '0',
    PHANTOM_CLI_VOICE_WAKE: cfg.voice_wake_word ? '1' : '0',
    PHANTOM_CLI_VOICE_WAKE_WORDS: s(cfg.voice_wake_words),
    PHANTOM_CLI_VOICE_WAKE_TIMEOUT: s(cfg.voice_wake_timeout),
  };
}

// --- the chat -----------------------------------------------------------------

export type VoiceStatus = 'off' | 'starting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'error';

export interface VoiceSnapshot {
  status: VoiceStatus;
  /** One line for the header — the status, or what is being installed. */
  detail?: string;
  /** All four switches are settings (voice_mic_muted / voice_speaker_muted /
   *  voice_headphones / voice_wake_word), shown as the engine last confirmed
   *  or a toggle last set them; `ready` restores the saved state. */
  micMuted: boolean;
  speakerMuted: boolean;
  headphones: boolean;
  wake: boolean;
  /** Wake only: the word was heard and the window is open — the Assistant
   *  answers (and records) without it. Back to false when the window lapses
   *  (the sidecar says so; the timeout is voice_wake_timeout). */
  awake: boolean;
  /** When the open window lapses (epoch ms) if nothing else is said — pushed
   *  forward by the sidecar as activity restarts the clock. The pane counts
   *  down to it. Null when not awake. */
  awakeUntil: number | null;
  devices: { mics: string[]; speakers: string[] };
  /** Finished parts, oldest first. */
  done: Part[];
  /** What is in flight: the partial transcript, the reply being written. */
  live: Part[];
  /** Last time-to-first-byte per stage, ms — the speed dashboard. The
   *  sidecar reports its stages (stt, tts); `llm` is measured here. */
  ttfb: Record<string, number>;
}

/** One turn of the brain, as the sidecar's `spoken` reports need it back:
 *  where it started in the history and how many of its steps have landed. */
interface Turn {
  id: string;
  abort: AbortController;
  /** Steps the stream has started (= the `step` in speak_start). */
  step: number;
  /** history.length when the turn began — its user message is at this index. */
  historyStart: number;
}

/** Index of the n-th (1-based) assistant message at or after `from`; -1 if
 *  there is no such message yet. One assistant message per step is what the
 *  agent produces, so step n of a turn is its n-th assistant message. */
export function nthAssistantIndex(history: ModelMessage[], from: number, n: number): number {
  let seen = 0;
  for (let i = from; i < history.length; i++) {
    if (history[i].role === 'assistant' && ++seen === n) return i;
  }
  return -1;
}

/** The assistant message with its text replaced by what was actually spoken
 *  (tool calls and anything else kept): the model must remember what you
 *  heard, not what it was going to say. */
export function truncateAssistant(m: ModelMessage, spoken: string): ModelMessage {
  if (m.role !== 'assistant') return m;
  if (typeof m.content === 'string') return { ...m, content: spoken };
  const rest = m.content.filter((c) => c.type !== 'text');
  const at = m.content.findIndex((c) => c.type === 'text');
  const text = { type: 'text' as const, text: spoken };
  const content = at < 0 ? [text, ...rest] : [...rest.slice(0, at), text, ...rest.slice(at)];
  return { ...m, content } as ModelMessage;
}

/** Confirmed speech + the next piece, one space between, either side empty. */
export function joinSpeech(a: string, b: string): string {
  return [a.trim(), b.trim()].filter(Boolean).join(' ');
}

export class VoiceClient {
  private proc: SidecarProcess | null = null;
  private subs = new Set<() => void>();
  private snap: VoiceSnapshot = {
    status: 'off', micMuted: false, speakerMuted: false, headphones: false, wake: false, awake: false, awakeUntil: null,
    devices: { mics: [], speakers: [] }, done: [], live: [], ttfb: {},
  };
  /** The transcript forming: STT-confirmed segments + the live guess for the
   *  current one. One turn confirms several segments (and a confirmation can
   *  cover LESS than the guess on screen — the tail comes back with the next
   *  segment), so the line is `heard + interim`, only ever replaced in place,
   *  and cleared only when `turn` swaps in the committed text — never on a
   *  confirmation, which is what made the pane blink. */
  private partial: { id: string; heard: string; interim: string } | null = null;
  private gen = 0;
  // The brain.
  private agent: Agent | null = null;
  /** The voice conversation, every message exactly as it goes to the model. */
  readonly history: ModelMessage[] = [];
  /** The reply in flight, as parts (text, tools) — the live half of the pane. */
  private reply: Part[] = [];
  /** Coalesces the pane's repaints while a reply streams (paintLive). The
   *  SPEECH wire is untouched — every delta still goes to the sidecar at
   *  once; this only spaces out how often the screen redraws, at the same
   *  FLUSH_MS the coding pane already uses. Unbatched, a full sidebar was
   *  measured redrawing 16 frames a second, and every row it scrolls is
   *  rewritten edge to edge — the left pane's flicker. */
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  private liveDirty = false;
  private cur: Turn | null = null;
  /** Recent turns by id, for `spoken` reports that arrive after a turn ended. */
  private turns = new Map<string, Turn>();
  private turnSeq = 0;
  /** Modal hook: while an approval prompt is on screen the App claims the
   *  next words — spoken or typed via /assistant, both land in turn(). The exact word
   *  "accept" or "decline" answers the prompt; anything else is swallowed
   *  (the prompt on screen says the two words). Return true = consumed: the
   *  text still shows in the pane as yours, but the brain does not run. */
  intercept: ((text: string) => boolean) | null = null;

  constructor(
    private spawner: Spawner = spawnSidecar,
    private transcriptDir: string | null = VOICE_DIR,
    private run: typeof runTurn = runTurn,
  ) {}

  subscribe(fn: () => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  snapshot(): VoiceSnapshot { return this.snap; }
  get running(): boolean { return this.proc !== null; }
  get busy(): boolean { return this.cur !== null; }

  private set(patch: Partial<VoiceSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.subs) fn();
  }

  private modelInfo = { provider: 'unknown', model: 'unknown' };
  private transcript: Transcript | null = null;

  /** The brain. Set before start, and again whenever the model config changes
   *  (the history stays; only the next turn sees the new model). `info` names
   *  what will answer — recorded in the transcript header. */
  setAgent(agent: Agent, info?: { provider: string; model: string }): void {
    this.agent = agent;
    if (info) this.modelInfo = info;
  }

  /** The conversation's record, on the shared format (core/llm/transcript.ts):
   *  header + one ModelMessage per line, one file per voice conversation
   *  (engine start), created on the first message. Same format as the coding
   *  sessions and the git fixer; never replayed — a restart is a fresh
   *  conversation, the file is the record. */
  private log(): Transcript | null {
    if (!this.transcriptDir) return null;
    if (!this.transcript) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      this.transcript = new Transcript({
        type: 'session', agent: 'assistant', provider: this.modelInfo.provider, model: this.modelInfo.model,
        created_at: new Date().toISOString(), system_prompt: assistantInstructions(),
      }, join(this.transcriptDir, `${stamp}.jsonl`));
    }
    return this.transcript;
  }

  /** Start (or restart) the sidecar with this environment. */
  async start(env: Record<string, string>): Promise<void> {
    this.stop();
    this.transcript = null;   // a fresh engine run is a fresh conversation and a fresh file
    const gen = ++this.gen;
    this.set({ status: 'starting', detail: 'starting…' });
    try {
      const proc = await this.spawner(
        env,
        (line) => { if (gen === this.gen) this.onLine(line); },
        (code, detail) => {
          if (gen !== this.gen) return;
          this.proc = null;
          if (this.snap.status !== 'off') {
            this.set({ status: 'error', detail: `voice engine stopped${code != null ? ` (exit ${code})` : detail ? ` (${detail})` : ''} — /voice to restart` });
          }
        },
        (text) => { if (gen === this.gen) this.set({ detail: text }); },
      );
      if (gen !== this.gen) { proc.kill(); return; }
      this.proc = proc;
    } catch (e) {
      if (gen === this.gen) this.set({ status: 'error', detail: (e as Error).message });
    }
  }

  /** Re-scan the mic/speaker lists — every time /voice opens, so a device
   *  plugged in after launch shows up. A running sidecar re-enumerates on
   *  request (it answers with a `devices` line); otherwise `devices.py` runs. */
  async refreshDevices(list: () => Promise<{ mics: string[]; speakers: string[] }> = listDevices): Promise<void> {
    if (this.running) { this.send({ type: 'devices' }); return; }
    const devices = await list();
    if (devices.mics.length || devices.speakers.length) this.set({ devices });
  }

  stop(): void {
    this.gen++;
    if (this.proc) {
      this.send({ type: 'shutdown' });
      this.proc.kill();
      this.proc = null;
    }
    this.cur?.abort.abort();
    this.partial = null;
    this.set({ status: 'off', detail: undefined, live: [] });
  }

  send(msg: VoiceOut): void { this.proc?.send(`${JSON.stringify(msg)}\n`); }

  /** Typed text to the Assistant — shown as yours, answered like speech. */
  say(text: string): boolean {
    if (!this.proc) return false;
    void this.turn(text);
    return true;
  }
  setMic(muted: boolean): void { this.set({ micMuted: muted }); this.send({ type: 'mic', muted }); }
  setSpeaker(muted: boolean): void { this.set({ speakerMuted: muted }); this.send({ type: 'speaker', muted }); }
  /** The two mode switches, pushed live (`set`) — never an engine restart. */
  setHeadphones(on: boolean): void { this.set({ headphones: on }); this.send({ type: 'set', headphones: on }); }
  setWake(on: boolean, words?: string, timeout?: number): void {
    this.set({ wake: on });
    this.send({
      type: 'set', wake: on,
      ...(words === undefined ? {} : { wake_words: words }),
      ...(timeout === undefined ? {} : { wake_timeout: timeout }),
    });
  }
  /** Stop generating and stop talking, now. */
  cancel(): void { this.cur?.abort.abort(); this.send({ type: 'cancel' }); }
  update(opts: { voice?: string; wake?: boolean; wake_words?: string; wake_timeout?: number }): void { this.send({ type: 'set', ...opts }); }

  private note(p: Part): void { this.set({ done: [...this.snap.done, p] }); }


  // --- the brain ---------------------------------------------------------------

  /** One turn: what you said → the Assistant → text to the sidecar as it streams.
   *  A turn that arrives while another runs replaces it — you spoke over it. */
  async turn(text: string): Promise<void> {
    text = text.trim();
    if (!text) return;
    this.note({ kind: 'user', id: nextId('vuser'), text });
    if (this.intercept?.(text)) return;
    if (!this.agent) {
      this.note({ kind: 'error', id: nextId('verr'), message: 'the Assistant has no model — /model' });
      return;
    }
    this.cur?.abort.abort();
    const t: Turn = { id: `vt${++this.turnSeq}`, abort: new AbortController(), step: 0, historyStart: this.history.length };
    this.cur = t;
    this.turns.set(t.id, t);
    for (const k of [...this.turns.keys()].slice(0, -8)) this.turns.delete(k);   // keep the recent few
    this.history.push({ role: 'user', content: text });
    this.log()?.append({ role: 'user', content: text });
    this.reply = [];
    this.set({ status: this.snap.status === 'speaking' ? 'speaking' : 'thinking', live: this.live() });
    const t0 = Date.now();
    let first = true;
    // ONE failure, ONE line — same rule as SessionStore.send: the SDK reports
    // a failed call as an `error` event in the stream AND as the rejection the
    // catch sees; when the stream already spoke, the catch stays quiet.
    let streamErrored = false;
    try {
      await this.run(
        this.agent, this.history,
        (parts) => {
          // Time to the first token (text, thinking or a tool call) — not to
          // the stream's own `start` markers, which arrive at once.
          if (first && parts.some((p) => p.type === 'text-delta' || p.type === 'reasoning-delta' || p.type === 'tool-call' || p.type === 'tool-input-start')) {
            first = false; this.set({ ttfb: { ...this.snap.ttfb, llm: Date.now() - t0 } });
          }
          if (parts.some((p) => p.type === 'error')) streamErrored = true;
          this.onParts(t, parts);
        },
        t.abort.signal,
        (msgs) => {
          if (t.abort.signal.aborted) return;
          this.history.push(...msgs);
        },
        0,   // speech wants every delta now, not batched for the screen
        // The transcript records the step (messages + usage line) through
        // createAgent's `record` seam — same abort rule as the history.
        { appendStep: (msgs, usage) => {
          if (!t.abort.signal.aborted) this.log()?.appendStep(msgs, usage);
        } },
      );
    } catch (e) {
      if (!t.abort.signal.aborted && !streamErrored) this.reply = [...this.reply, { kind: 'error', id: nextId('verr'), message: (e as Error).message }];
    } finally {
      if (this.cur === t) this.cur = null;
      if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = null; this.liveDirty = false; }
      const done = finalize(this.reply);
      this.reply = [];
      this.set({
        done: [...this.snap.done, ...done], live: this.live(),
        status: this.cur || this.snap.status === 'speaking' ? this.snap.status : this.snap.status === 'error' ? 'error' : 'listening',
      });
    }
  }

  /** Stream parts → the sidecar (speech) and the pane (parts). */
  private onParts(t: Turn, parts: StreamPart[]): void {
    for (const part of parts) {
      if (part.type === 'start-step') { t.step++; this.send({ type: 'speak_start', turn: t.id, step: t.step }); }
      else if (part.type === 'text-delta') this.send({ type: 'speak_delta', turn: t.id, text: part.text });
      else if (part.type === 'finish-step') this.send({ type: 'speak_end', turn: t.id });
      this.reply = applyPart(this.reply, part);
    }
    this.paintLive();
  }

  /** Repaint the pane now if it has been quiet, else once FLUSH_MS is up —
   *  leading edge so the first token shows at once, trailing so the last
   *  delta of a burst always lands. */
  private paintLive(): void {
    if (this.liveTimer) { this.liveDirty = true; return; }
    this.set({ live: this.live() });
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null;
      if (this.liveDirty) { this.liveDirty = false; this.paintLive(); }
    }, FLUSH_MS);
  }

  /** The sidecar's account of one step once it has been said: in full, nothing
   *  to do; cut short, the history must hold the spoken part and no more. */
  private onSpoken(m: Extract<VoiceIn, { type: 'spoken' }>): void {
    if (!m.interrupted) return;
    const t = this.turns.get(m.turn);
    if (!t) return;
    const i = nthAssistantIndex(this.history, t.historyStart, m.step);
    if (i >= 0) this.history[i] = truncateAssistant(this.history[i], m.text);
    else if (m.text.trim()) this.history.push({ role: 'assistant', content: m.text });
    // The record: the full step is already on disk; this event says what the
    // user actually heard. Events are invisible to replay (no `role`).
    this.log()?.appendEvent({ type: 'interrupted', step: m.step, spoken: m.text });
    // The pane: trim what is on screen to what was heard.
    const trim = (ps: Part[]) => {
      const last = [...ps].reverse().find((p) => p.kind === 'text');
      return ps.map((p) => (p === last ? { ...p, text: m.text } : p));
    };
    if (this.cur === t) this.reply = trim(this.reply);
    else this.set({ done: trim(this.snap.done) });
    this.set({ live: this.live() });
  }

  private onLine(line: string): void {
    let msg: VoiceIn;
    try { msg = JSON.parse(line) as VoiceIn; } catch { log(`bad line from sidecar: ${line}`); return; }
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
    switch (msg.type) {
      case 'ready':
        this.set({
          status: 'listening', detail: undefined, devices: msg.devices,
          micMuted: msg.mic_muted ?? this.snap.micMuted, speakerMuted: msg.speaker_muted ?? this.snap.speakerMuted,
          headphones: msg.headphones ?? this.snap.headphones, wake: msg.wake ?? this.snap.wake,
          awake: false, awakeUntil: null,   // a fresh engine starts gated
        });
        return;
      case 'status':
        if (msg.speaking !== undefined) this.set({ status: msg.speaking ? 'speaking' : this.cur ? 'thinking' : 'listening' });
        if (msg.hearing !== undefined && this.snap.status !== 'speaking' && !this.cur) this.set({ status: msg.hearing ? 'hearing' : 'listening' });
        if (msg.mic_muted !== undefined) this.set({ micMuted: msg.mic_muted });
        if (msg.speaker_muted !== undefined) this.set({ speakerMuted: msg.speaker_muted });
        if (msg.headphones !== undefined) this.set({ headphones: msg.headphones });
        if (msg.wake !== undefined) this.set({ wake: msg.wake });
        if (msg.awake !== undefined) {
          // The window lapsing gates the sidecar's `user` lines, so no `turn`
          // will ever swap the forming line out — clear it here or whatever
          // was heard last sits on the pane for good.
          if (!msg.awake) this.partial = null;
          this.set({
            awake: msg.awake,
            awakeUntil: !msg.awake ? null
              : msg.awake_secs ? Date.now() + msg.awake_secs * 1000 : this.snap.awakeUntil,
            ...(msg.awake ? {} : { live: this.live() }),
          });
        }
        return;
      case 'user': {
        // The transcript forming, for the eye only; `turn` is what counts.
        // A confirmed segment folds into `heard`; a guess replaces `interim`.
        const p = this.partial ?? { id: nextId('vpart'), heard: '', interim: '' };
        if (msg.final) { p.heard = joinSpeech(p.heard, msg.text); p.interim = ''; }
        else p.interim = msg.text;
        this.partial = p;
        this.set({ live: this.live() });
        return;
      }
      case 'turn':
        // The committed text replaces the forming line in the SAME frame:
        // everything here up to turn()'s first await runs in one batch, so the
        // pane never shows a frame with neither.
        this.partial = null;
        this.set({ live: this.live() });
        void this.turn(msg.text);
        return;
      case 'interrupted':
        this.cur?.abort.abort();
        return;
      case 'spoken':
        this.onSpoken(msg);
        return;
      case 'metrics':
        this.set({ ttfb: { ...this.snap.ttfb, [msg.processor]: msg.ttfb_ms } });
        return;
      case 'devices':
        this.set({ devices: msg.devices });
        return;
      case 'warn':
        this.note({ kind: 'error', id: nextId('verr'), message: msg.message });
        return;
      case 'error':
        this.note({ kind: 'error', id: nextId('verr'), message: msg.message });
        this.set({ status: 'error', detail: msg.message });
        return;
    }
  }

  private live(): Part[] {
    const out: Part[] = [];
    if (this.partial) {
      const text = joinSpeech(this.partial.heard, this.partial.interim);
      if (text) out.push({ kind: 'user', id: this.partial.id, text });
    }
    out.push(...this.reply);
    return out;
  }
}

/** A client that never spawns anything — for tests that render App and are not
 *  about voice. Without it a test that reads the real settings file (voice on)
 *  would start the real sidecar, which is exactly what happened once. */
export const inertVoice = (): VoiceClient =>
  new VoiceClient(async () => ({ send() {}, kill() {} }), null);

// --- the one tool, for now ----------------------------------------------------

// The session_* and kanban_* families are declared whole in the TUI kit
// (core/llm/tools/tui.ts); the App
// supplies the handler body (it reads the session store directly). Re-exported
// here because this file is the Assistant's client-side home.
export { sessionsTool, assistantKanbanTool, codingKanbanTool, workspaceCreateTool, gitAutoPushTool, gitAutoPullTool, screenModeTools, kebabName, renderRead, type SessionsArgs, type KanbanArgs, type WorkspaceCreateArgs, type GitAutoPushArgs, type GitAutoPullArgs, type ScreenModeHandler } from '../core/llm/tools/tui.js';

export function sidecarDirExists(): boolean { return existsSync(dirname(join(SIDECAR_DIR, 'bot.py'))); }
