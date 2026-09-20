// The settings that stay on THIS machine — declared here, and only these.
// Deliberately the same shape as the server's settings.ts: DEFAULTS live in
// code, the file holds ONLY what you changed. So an untouched setting follows
// the default when the default moves, and an explicit one is pinned — which
// is why "reset" is a real action, distinct from typing today's default back
// in.
//
// Every OTHER setting is the server's, and the server is the one place it is
// declared — default, type, label, description, choices — served on every
// entry of GET /settings and rendered verbatim by the screens. This file used
// to carry a copy of the server keys the /settings and /assistant screens show;
// the copies drifted (a description said one thing here and another there,
// a provider list here that the server refused). Nothing about a server key
// lives here now.
//
// One file, CONFIG_DIR/settings.json. CONFIG_DIR is the ONE root every file the
// cli owns hangs off (settings.json, sessions/, voice/, bin/, ca/, cli.log,
// models-cache.json): ~/.phantom-cli for an installed build, <repo>/.phantom-cli
// (gitignored) when running from source. build-cli.sh bakes the release string
// into process.env.PHANTOM_CLI_VERSION; a checkout reads nothing and is 'dev'.
// So a dev run and the installed app never share a byte — dev talks to the
// server setup.sh brought up (it seats the url + key there), installed talks to
// yours. Beyond that there is no per-directory config: a phantom-looper
// workspace is remote, so the directory you launched from says nothing about
// which one you want. PHANTOM_CLI_DIR is the test seam: the suite points it at
// a fresh temp dir so App's own file writes (the seating rule, the sidecar
// log) never land in a real home.
//
// Precedence (resolved in local.ts): code defaults -> settings.json -> env
// vars. Env still wins so scripts and CI keep working; the UI shows which
// source a value came from, because "I changed it and nothing happened" is
// the single worst thing a settings screen can do to you.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const CONFIG_DIR = process.env.PHANTOM_CLI_DIR
  || ((process.env.PHANTOM_CLI_VERSION ?? 'dev') === 'dev'
    ? resolve(import.meta.dirname, '..', '.phantom-cli')
    : join(homedir(), '.phantom-cli'));
export const CONFIG_PATH = join(CONFIG_DIR, 'settings.json');

/** THE split, declared once. Local is what cannot be right anywhere else: the
 *  address of the server (you edit it precisely when the server is unreachable),
 *  this machine's own update preference (the server would share one choice
 *  across every cli you open), and facts about the machine you are sitting at
 *  — which microphone, which speaker, whether you are wearing headphones,
 *  whether you muted yourself here. A device name is wrong on your other
 *  machine; a model choice is not. */
export const DEFAULTS = {
  server_url: 'http://localhost:8080' as string,
  server_key: null as string | null,
  auto_update: true as boolean,
  voice_mic_device: null as string | null,
  voice_speaker_device: null as string | null,
  voice_mic_muted: false as boolean,
  voice_speaker_muted: false as boolean,
  voice_headphones: false as boolean,
};

export type LocalKey = keyof typeof DEFAULTS;
export const LOCAL_KEYS = Object.keys(DEFAULTS) as LocalKey[];
export const isLocalKey = (k: string): k is LocalKey => Object.prototype.hasOwnProperty.call(DEFAULTS, k);

/** A setting's value on the wire and in the file. */
export type ConfigValue = string | number | boolean | null;

export const DESCRIPTIONS: Record<LocalKey, string> = {
  server_url: 'Base URL of the phantom-looper API.',
  server_key: 'Bearer token for the phantom-looper API (its API_KEY).',
  auto_update: 'Check for a new phantom-cli release about once a day and install it in the background. It runs on next launch — the version label above the prompt says when one is ready.',
  voice_mic_device: 'Microphone, by device name. Empty = the system default.',
  voice_speaker_device: 'Speaker, by device name. Empty = the system default.',
  voice_mic_muted: 'Stop listening. What /mic and a click on the pane toggle — saved, so it holds across restarts.',
  voice_speaker_muted: 'Stop speaking out loud; the text still streams. What /speaker and a click on the pane toggle — saved, so it holds across restarts.',
  voice_headphones: 'On = you wear headphones, so the mic stays open while the Assistant speaks and you can talk over it. Off = the mic is muted while it speaks (speakers would feed its own voice back).',
};

export interface ConfigMeta {
  type: 'string' | 'number' | 'boolean';
  /** What to call it on screen. Same rule as the server's META.label: a plain
   *  noun that reads with its value beside it. */
  label: string;
  /** Masked in the UI and shown as its last four characters. */
  secret?: boolean;
  /** The screen this row belongs to: /server or /assistant. */
  group: 'server' | 'voice';
  /** Env vars that override the file, most specific first. */
  env?: readonly string[];
}

export const META: Record<LocalKey, ConfigMeta> = {
  server_url: { type: 'string', label: 'server url', group: 'server', env: ['PHANTOM_BACKEND_URL'] },
  server_key: { type: 'string', label: 'api key', secret: true, group: 'server', env: ['PHANTOM_BACKEND_KEY', 'API_KEY'] },
  auto_update: { type: 'boolean', label: 'auto update', group: 'server', env: ['PHANTOM_CLI_AUTO_UPDATE'] },
  voice_mic_device: { type: 'string', label: 'microphone', group: 'voice' },
  voice_speaker_device: { type: 'string', label: 'speaker', group: 'voice' },
  voice_mic_muted: { type: 'boolean', label: 'mic muted', group: 'voice' },
  voice_speaker_muted: { type: 'boolean', label: 'speaker muted', group: 'voice' },
  voice_headphones: { type: 'boolean', label: 'headphones', group: 'voice' },
};

/** The audio settings the sidecar only reads when it starts. Changing one of
 *  these while it runs means a restart; the rest — the spoken voice, the
 *  headphones switch, the wake word — are pushed to it live (`set`). Any
 *  other server setting rebuilds the Assistant's brain from the server's
 *  config (window.ts settingChanged): which keys shape an agent is the
 *  server's rule, kept nowhere here. */
export const VOICE_BOOT_KEYS: string[] = [
  'deepgram_api_key', 'voice_mic_device', 'voice_speaker_device', 'voice_stt_model',
];

export function validate(key: LocalKey, value: ConfigValue): string | null {
  const m = META[key];
  if (value === null) return null;                       // null clears a setting
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
