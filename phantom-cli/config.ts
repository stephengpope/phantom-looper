// Client-side settings for the TUI. Deliberately the same shape as
// server/settings.ts: DEFAULTS live in code, the file holds ONLY what you changed.
// So an untouched setting follows the default when the default moves, and an
// explicit one is pinned — which is why "reset" is a real action, distinct from
// typing today's default back in.
//
// One file, ~/.phantom-cli/settings.json. There is no per-directory config: a
// phantom-looper workspace is remote, so the directory you launched from says
// nothing about which one you want.
//
// Precedence (resolved in local.ts, and only for the machine-local keys):
// code defaults -> settings.json -> env vars. Env still wins so scripts and CI
// keep working; the UI shows which source a value came from, because "I
// changed it and nothing happened" is the single worst thing a settings screen
// can do to you.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_DIR = join(homedir(), '.phantom-cli');
export const CONFIG_PATH = join(CONFIG_DIR, 'settings.json');

export const PROVIDERS = ['anthropic', 'openai', 'google', 'openai-compatible'] as const;
export const REASONINGS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export const DEFAULTS = {
  provider: 'anthropic' as string,
  model: 'claude-opus-5' as string,
  base_url: null as string | null,
  reasoning: 'medium' as string,
  max_steps: null as number | null,
  server_url: 'http://localhost:8080' as string,
  server_key: null as string | null,
  // The Assistant and its voice (a Python sidecar the TUI starts; see voice.ts).
  voice_enabled: false as boolean,
  sidebar_width: 20 as number,
  assistant_provider: null as string | null,
  assistant_model: null as string | null,
  assistant_base_url: null as string | null,
  voice_spoken_voice: 'aura-2-thalia-en' as string,
  voice_mic_device: null as string | null,
  voice_speaker_device: null as string | null,
  voice_deepgram_address: null as string | null,
  voice_mic_muted: false as boolean,
  voice_speaker_muted: false as boolean,
  voice_headphones: false as boolean,
  voice_wake_word: false as boolean,
  voice_wake_words: 'computer' as string,
  voice_wake_timeout: 8 as number,
};

/** THE split, declared once. Local is what cannot be right anywhere else: the
 *  address of the server (you edit it precisely when the server is unreachable)
 *  and facts about the machine you are sitting at — which microphone, which
 *  speaker, whether you are wearing headphones, whether you muted yourself here.
 *  A device name is wrong on your other machine; a model choice is not.
 *
 *  Everything else lives on the server, so every TUI you open is the same one.
 *  Two homes, two modules (local.ts, settings.ts), no routing: a call site can
 *  see which it is reading. */
export const LOCAL_KEYS = [
  'server_url', 'server_key',
  'voice_mic_device', 'voice_speaker_device', 'voice_headphones',
  'voice_mic_muted', 'voice_speaker_muted', 'voice_deepgram_address',
] as const;
export type LocalKey = (typeof LOCAL_KEYS)[number];
export const isLocalKey = (k: string): k is LocalKey => (LOCAL_KEYS as readonly string[]).includes(k);

/** The defaults for the server-held half. The same values as always; where they
 *  are stored is what changed. */
export const REMOTE_DEFAULTS = Object.fromEntries(
  (Object.keys(DEFAULTS) as ConfigKey[]).filter((k) => !isLocalKey(k)).map((k) => [k, DEFAULTS[k]]),
) as Record<string, ConfigValue>;

/** The provider API keys are the SERVER's — one key per provider, one place to
 *  set it (/keys). Declared once in core (the same map every agent builds
 *  from) and re-exported here for the app's screens. */
import { PROVIDER_KEY } from '../core/llm/agentConfig.js';
export { PROVIDER_KEY };

export type ConfigKey = keyof typeof DEFAULTS;
export type ConfigValue = string | number | boolean | null;

export const DESCRIPTIONS: Record<ConfigKey, string> = {
  provider: 'The coding agent\'s LLM provider. Its key is set on /keys.',
  model: 'Model id for the chosen provider.',
  base_url: 'Endpoint for openai / openai-compatible. Required by openai-compatible.',
  reasoning: 'How much the model thinks before answering. Providers map this to their own setting.',
  max_steps: 'Tool calls allowed per turn before the agent must stop and answer. Empty = unlimited (esc still interrupts).',
  server_url: 'Base URL of the phantom-looper API.',
  server_key: 'Bearer token for the phantom-looper API (its API_KEY).',
  voice_enabled: 'Start the Assistant with the TUI. It listens on the mic, answers out loud and in the voice pane (ctrl+g), and can act on the TUI through its tools.',
  sidebar_width: 'Width of the voice pane as a percent of the terminal.',
  assistant_provider: 'The AI provider the Assistant answers on, on its key from /keys. Empty = the coding agent\'s provider.',
  assistant_model: 'Model the Assistant answers with. Empty = the coding agent\'s model; required when the provider differs from the coding agent\'s. A small fast model keeps replies quick.',
  assistant_base_url: 'Endpoint when the Assistant\'s provider is openai-compatible. Empty inherits the coding agent\'s only while the provider matches.',
  voice_spoken_voice: 'Deepgram Aura voice the Assistant speaks with, e.g. aura-2-thalia-en, aura-2-orion-en.',
  voice_mic_device: 'Microphone, by device name. Empty = the system default.',
  voice_speaker_device: 'Speaker, by device name. Empty = the system default.',
  voice_deepgram_address: 'The Deepgram address that last answered from this machine. Found by the engine and saved here, so a restart starts on it. Empty = ask DNS.',
  voice_mic_muted: 'Stop listening. What /mic and a click on the pane toggle — saved, so it holds across restarts.',
  voice_speaker_muted: 'Stop speaking out loud; the text still streams. What /speaker and a click on the pane toggle — saved, so it holds across restarts.',
  voice_headphones: 'On = you wear headphones, so the mic stays open while the Assistant speaks and you can talk over it. Off = the mic is muted while it speaks (speakers would feed its own voice back).',
  voice_wake_word: 'On = the Assistant only answers when it hears one of the wake words (and for a few seconds after). Off = it answers everything it hears.',
  voice_wake_words: 'Words that address the Assistant when wake is on, comma-separated.',
  voice_wake_timeout: 'Seconds of silence after the wake word before it is needed again. Any speech — yours or the Assistant\'s — restarts the clock.',
};

export interface ConfigMeta {
  type: 'string' | 'number' | 'boolean';
  /** What to call it on screen. Same rule as the server's META.label: a plain
   *  noun that reads with its value beside it. Absent, the screen prints the
   *  key with underscores removed (voice rows also drop their `voice_`). */
  label?: string;
  choices?: readonly string[];
  /** Masked in the UI and shown as its last four characters. */
  secret?: boolean;
  group: 'model' | 'server' | 'voice';
  /** Hidden when it cannot apply — see `visibleKeys`. */
  appliesWhen?: (cfg: Record<ConfigKey, ConfigValue>) => boolean;
  /** Env vars that override the file, most specific first. */
  env?: readonly string[];
}

const usesBaseUrl = (p: unknown) => p === 'openai' || p === 'openai-compatible';

export const META: Record<ConfigKey, ConfigMeta> = {
  provider: { type: 'string', choices: PROVIDERS, group: 'model' },
  model: { type: 'string', group: 'model' },
  base_url: { type: 'string', label: 'endpoint', group: 'model',
    appliesWhen: (c) => usesBaseUrl(c.provider) },
  reasoning: { type: 'string', choices: REASONINGS, group: 'model' },
  max_steps: { type: 'number', label: 'steps per turn', group: 'model' },
  server_url: { type: 'string', group: 'server', env: ['PHANTOM_BACKEND_URL'] },
  server_key: { type: 'string', label: 'api key', secret: true, group: 'server', env: ['PHANTOM_BACKEND_KEY', 'API_KEY'] },
  voice_enabled: { type: 'boolean', label: 'assistant', group: 'voice' },
  sidebar_width: { type: 'number', label: 'pane width', group: 'voice' },
  assistant_provider: { type: 'string', choices: PROVIDERS, group: 'voice' },
  assistant_model: { type: 'string', group: 'voice' },
  assistant_base_url: { type: 'string', label: 'assistant endpoint', group: 'voice',
    appliesWhen: (c) => usesBaseUrl(c.assistant_provider || c.provider) },
  voice_spoken_voice: { type: 'string', group: 'voice' },
  voice_mic_device: { type: 'string', label: 'microphone', group: 'voice' },
  voice_speaker_device: { type: 'string', label: 'speaker', group: 'voice' },
  voice_deepgram_address: { type: 'string', label: 'deepgram address', group: 'voice' },
  voice_mic_muted: { type: 'boolean', label: 'mic muted', group: 'voice' },
  voice_speaker_muted: { type: 'boolean', label: 'speaker muted', group: 'voice' },
  voice_headphones: { type: 'boolean', group: 'voice' },
  voice_wake_word: { type: 'boolean', label: 'wake word only', group: 'voice' },
  voice_wake_words: { type: 'string', group: 'voice', appliesWhen: (c) => c.voice_wake_word === true },
  voice_wake_timeout: { type: 'number', label: 'wake timeout', group: 'voice', appliesWhen: (c) => c.voice_wake_word === true },
};

/** The audio settings the sidecar only reads when it starts. Changing one of
 *  these while it runs means a restart; the rest — the spoken voice, the
 *  headphones switch, the wake word — are pushed to it live (`set`). */
export const VOICE_BOOT_KEYS: string[] = [
  'deepgram_api_key', 'voice_mic_device', 'voice_speaker_device',
];

/** The settings the Assistant's model is built from. Changing one rebuilds
 *  the brain in place (agentFromConfig.buildAssistantAgent); the sidecar is
 *  not touched — it never sees the model or its key. */
export const ASSISTANT_MODEL_KEYS: string[] = [
  'provider', 'model', 'base_url',
  'assistant_provider', 'assistant_model', 'assistant_base_url',
  ...Object.values(PROVIDER_KEY),
];

export function validate(key: ConfigKey, value: ConfigValue): string | null {
  const m = META[key];
  if (value === null) return null;                       // null clears a setting
  if (m.choices) {
    return typeof value === 'string' && m.choices.includes(value)
      ? null : `${key} must be one of: ${m.choices.join(', ')}`;
  }
  if (m.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? null : `${key} must be a positive number`;
  }
  if (m.type === 'boolean') return typeof value === 'boolean' ? null : `${key} must be true or false`;
  return typeof value === 'string' ? null : `${key} must be text`;
}

/** Last four characters of a secret — enough to tell two keys apart, not enough
 *  to leak one. Never a fake row of dots for a key that is not set. */
export function mask(v: ConfigValue): string {
  if (v === null || v === undefined || v === '') return 'not set';
  const s = String(v);
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
}

/** Keys worth showing right now, in display order. Hides what cannot apply —
 *  other providers' keys, base_url when the provider ignores it. */
export function visibleKeys(cfg: Record<ConfigKey, ConfigValue>): ConfigKey[] {
  return (Object.keys(DEFAULTS) as ConfigKey[])
    .filter((k) => META[k].appliesWhen?.(cfg) ?? true);
}

/** Provider keys that are set but hidden because you are not using them. The
 *  keys live on the server now, so this takes the resolved set rather than
 *  reading a file. */
export function hiddenKeyCount(cfg: Record<string, ConfigValue>): number {
  const active = PROVIDER_KEY[String(cfg.provider) as keyof typeof PROVIDER_KEY];
  return Object.values(PROVIDER_KEY)
    .filter((k) => k !== active && cfg[k] !== null && cfg[k] !== undefined && cfg[k] !== '').length;
}
