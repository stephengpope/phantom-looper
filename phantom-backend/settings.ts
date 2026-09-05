// Settings resolution. Defaults live HERE, in code — the database holds only
// explicit overrides, so a new setting ships working with no migration and
// "unset" stays distinct from "set to the current default" (unset follows the
// default when it changes; an override does not).
//
// Read at the point of use, never cached at boot: a settings change must take
// effect without a restart or the config API lies.
import type { Db } from './db/client.js';
import type { WorkspaceRow, SessionRow } from './db/schema.js';
import { readStore, GLOBAL, workspaceScope, sessionScope } from './store.js';

// Plain settings are never encrypted, so resolving one asks for plain values
// only (null key) — a credential is read by resolveCredential, which is handed
// the key explicitly and is the only path that should be.

// The workspace image default tracks THIS server's release: a tagged build
// names the workspace image at the same tag (both are published together by
// the release workflow), a dev build names :latest (scripts/setup.sh builds
// it locally under that tag). Pulled on first use — see container.ts.
const APP_VERSION = process.env.APP_VERSION ?? 'dev';
const FS_IMAGE_TAG = /^v\d+\.\d+\.\d+/.test(APP_VERSION) ? APP_VERSION : 'latest';

export const DEFAULTS = {
  spare_clones: 2,
  maintenance_interval_ms: 60_000,
  spare_clone_refresh_ms: 3_600_000,        // performance only — the claim fetch is the guarantee
  spare_clone_max_age_ms: 7 * 24 * 3_600_000, // evict and re-stock rather than re-deepen
  session_idle_destroy_ms: 30 * 24 * 3_600_000,
  container_idle_ms: 30 * 60_000,
  container_memory_mb: null as number | null, // unset => no cap (Docker default)
  container_cpus: null as number | null,      // unset => no cap (Docker default)
  container_pids_limit: null as number | null, // unset => no cap (Docker default)
  initial_history_depth: '7.days',   // 'full' disables shallow
  container_image: `ghcr.io/stephengpope/phantom-backend-fs:${FS_IMAGE_TAG}` as string,
  container_docker: true as boolean, // privileged + a graph-storage volume so the agent can run its OWN dockerd inside
  bash_timeout_ms: 120_000 as number | null,   // two minutes, as OpenCode; the agent passes a longer one per command
  bash_timeout_max_ms: null as number | null,
  max_read_bytes: 262_144,
  max_search_results: 200,
  max_bash_output_bytes: 1_048_576,
  session_lock_ttl_ms: 600_000,
  auto_push_on_archive: false as boolean,
  agent_git_credentials: false as boolean,
  // The Git Fixer's model config: an agent trio (provider/model/base_url),
  // null = the coding agent's, per the cascade rule (core agentModelConfig).
  auto_push_fix_attempts: 3,
  git_fixer_provider: null as string | null,
  git_fixer_model: null as string | null,
  git_fixer_base_url: null as string | null,   // openai-compatible endpoints (Ollama, vLLM, OpenRouter, ...)
  card_prefix: null as string | null,   // unset => derived from the repo name
  // The coding agent's model config. ONE store now: the cli and the server's
  // looper read the same rows, which is what makes "the experience is the
  // same" literal.
  provider: 'anthropic' as string,
  model: 'claude-opus-5' as string,
  base_url: null as string | null,
  reasoning: 'medium' as string,
  max_steps: null as number | null,
  // The Assistant's trio — null = the coding agent's (cascade rule).
  assistant_provider: null as string | null,
  assistant_model: null as string | null,
  assistant_base_url: null as string | null,
  // The Assistant's pane — rendered by the cli, stored here so every cli you
  // open is the same one.
  voice_enabled: false as boolean,
  sidebar_width: 20,
  voice_spoken_voice: 'aura-2-thalia-en' as string,
  // The ONE transcription model, for both ears: the cli's voice pane (the
  // sidecar's live stream) and Telegram voice notes (deepgram.ts).
  voice_stt_model: 'nova-3' as string,
  voice_wake_word: false as boolean,
  voice_wake_words: 'computer' as string,
  voice_wake_timeout: 8,
  // The looper: the supervisor loop over kanban cards — TWO switches, one per
  // loop column (a card's own auto_plan/auto_build tri-state overrides them).
  // The supervisor's trio — null = the coding agent's (cascade rule).
  auto_plan: false as boolean,
  auto_build: false as boolean,
  loop_budget_tokens: null as number | null,   // null = no limit
  supervisor_provider: null as string | null,
  supervisor_model: null as string | null,
  supervisor_base_url: null as string | null,
  // The cli's boot: skip the workspace picker, start where you last worked.
  boot_last_workspace: false as boolean,
  // Telegram: the bot as a client of this server (phantom-backend/telegram/).
  // The webhook URL is never a setting — it is always https://
  // PHANTOM_BACKEND_ADDRESS, the same fact the https profile runs on.
  telegram_enabled: false as boolean,
  telegram_authorized_user: null as string | null,
  telegram_reply_mode: 'text' as string,
  telegram_transcript_echo: false as boolean,
} as const;

/** The credentials the SERVER holds, declared here so nothing can store one in
 *  the clear by forgetting a flag. Named the way each vendor names it: GitHub
 *  says token, everyone else says API key.
 *
 *  There is no `auto_push_api_key`. The Git Fixer holds a key FOR a provider,
 *  and which provider is `auto_push_fix_provider` — so it reads the key for
 *  whatever that says, the same row the TUI's own agent reads. One key per
 *  provider, one place to set it. */
export const CREDENTIALS = {
  github_token: 'Lets phantom-looper manage GitHub repos: clone, push, and land work on the base branch. A workspace can hold its own token; otherwise this one is used.',
  anthropic_api_key: 'Used by every agent set to the anthropic provider.',
  openai_api_key: 'Used by every agent set to the openai provider.',
  google_api_key: 'Used by every agent set to the google provider (Gemini).',
  openai_compatible_api_key: 'For OpenAI-compatible endpoints — Ollama, vLLM, OpenRouter. Not the same key as OpenAI.',
  deepgram_api_key: 'Speech to text and text to speech for the Assistant.',
  telegram_bot_token: 'The Telegram bot\'s token from @BotFather. Saving it (with telegram settings enabled) registers the webhook.',
  firecrawl_api_key: 'Powers the web_search and web_fetch tools; without it web calls fail. Keys at firecrawl.dev.',
} as const;

export type CredentialName = keyof typeof CREDENTIALS;
export const CREDENTIAL_NAMES = Object.keys(CREDENTIALS) as CredentialName[];
export const isCredential = (k: string): k is CredentialName =>
  Object.prototype.hasOwnProperty.call(CREDENTIALS, k);

/** The key holding the API key for one provider. `auto_push_fix_provider` and
 *  the TUI's own `provider` both name a provider; this turns either into the
 *  one row that holds its key. */
export const credentialForProvider = (p: string): CredentialName =>
  (`${p.replace(/-/g, '_')}_api_key`) as CredentialName;

/** What each setting does, in one or two plain sentences — and, where it
 *  matters, WHEN a change starts applying. Served by GET /settings and
 *  rendered verbatim by the TUI: this is the ONE place a setting's meaning is
 *  written down. A client that needed its own friendlier copy would be a
 *  second source to keep in step, and the two would drift — fix a bad line
 *  here. */
export const DESCRIPTIONS: Record<keyof typeof DEFAULTS, string> = {
  spare_clones: 'Clones of the repo kept ready and waiting. A new session takes one instead of waiting for a clone. Each one costs disk.',
  maintenance_interval_ms: 'How often the maintenance loop runs — restocking spare clones, session idle cleanup, stopping idle containers. Every other "after this long" setting is only checked this often.',
  spare_clone_refresh_ms: 'A spare clone older than this is brought up to date in the background. Speed only: a session always fetches when it takes one.',
  spare_clone_max_age_ms: 'A spare clone older than this is thrown away and cloned fresh.',
  session_idle_destroy_ms: 'How long an unused session keeps its clone on disk. After this it is deleted — the session, its branch and its pushed work all survive, but reopening it has to clone again.',
  container_idle_ms: 'How long a container sits unused before it is stopped. The next tool call starts a fresh one, costing a second or two. This is also when a changed image or token setting takes effect.',
  container_memory_mb: 'Unset (the default) means no cap — the container uses what the host allows. Set it only to protect a shared host; too low and builds and tests get killed part-way through.',
  container_cpus: 'Unset (the default) means no cap. Set it only to keep one session from starving others on a shared host; fewer cores makes work slower, not impossible.',
  container_pids_limit: 'Unset (the default) means no cap. Set it only as fork-bomb protection on a shared host; too low and a normal parallel build hits it.',
  initial_history_depth: "How much git history a new clone gets — a span like '7.days', or 'full' for all of it. Less means a faster clone and less disk, but the agent cannot see past it. Fixed when the clone is made.",
  container_image: 'Must contain ripgrep. Pulled the first time a session needs it; a change applies when the container next restarts.',
  container_docker: 'Lets the agent run Docker inside its own container. The container gets privileged mode and a native-overlay graph-storage volume, but the daemon is NOT started for you — the agent runs `start-docker` when it wants it, so idle sessions pay nothing. Privileged is a weaker boundary: turn this off for a hardened workspace. Applies when the container next restarts.',
  bash_timeout_ms: 'Kills a command that set no timeout of its own; the agent can ask for a longer one per command.',
  bash_timeout_max_ms: 'The longest timeout the agent may request for one command. Unset means no limit.',
  max_read_bytes: 'Cap on bytes returned per file read. Bigger files are read in chunks — nothing is hidden, it just takes more calls.',
  max_search_results: 'Cap on hits returned per search; the true total is still reported.',
  max_bash_output_bytes: 'Cap on output kept per command; anything past it is dropped.',
  session_lock_ttl_ms: 'How long a crashed turn keeps its session locked before the hold expires. Locks live per TURN — reading a session never takes one — so this is crash recovery, sized to the longest turn.',
  auto_push_on_archive: 'Archiving a done card auto-pushes its session\'s work to the base branch; a failed push un-archives the card into blocked. Archiving from any other column never pushes.',
  agent_git_credentials: 'Puts the GitHub token inside the container so the agent can run git and gh itself — the agent can then read it. Applies when the container restarts; off does not reclaim it from a running one.',
  auto_push_fix_attempts: 'How many times the AI may retry one merge conflict, each try keeping the last one\'s progress. More tries cost more tokens.',
  git_fixer_provider: 'The AI provider that resolves merge conflicts and writes auto-push commit messages, on its key from /keys. Empty = the coding agent\'s provider.',
  git_fixer_model: 'The model that resolves merge conflicts and writes auto-push commit messages — not the model you chat with. Empty = the coding agent\'s model; required when the provider differs from the coding agent\'s.',
  git_fixer_base_url: 'Endpoint when the Git Fixer\'s provider is openai-compatible (Ollama, vLLM, OpenRouter). Empty inherits the coding agent\'s only while the provider matches.',
  card_prefix: 'The letters in front of every card number on this board — "PHA" gives PHA-7. Unset means the first three letters of the repo name.',
  provider: 'The coding agent\'s LLM provider. Its key is set on /keys.',
  model: 'Model id for the chosen provider.',
  base_url: 'Endpoint for openai / openai-compatible. Required by openai-compatible.',
  reasoning: 'How much the model thinks before answering. Providers map this to their own setting.',
  max_steps: 'Tool calls allowed per turn before the agent must stop and answer. Empty = unlimited.',
  assistant_provider: 'The AI provider the Assistant answers on, on its key from /keys. Empty = the coding agent\'s provider.',
  assistant_model: 'Model the Assistant answers with. Empty = the coding agent\'s model; required when the provider differs from the coding agent\'s. A small fast model keeps replies quick.',
  assistant_base_url: 'Endpoint when the Assistant\'s provider is openai-compatible. Empty inherits the coding agent\'s only while the provider matches.',
  voice_enabled: 'Start the Assistant with the cli. It listens on the mic, answers out loud and in the voice pane (ctrl+g), and can act on the cli through its tools.',
  sidebar_width: 'Width of the voice pane as a percent of the terminal.',
  voice_spoken_voice: 'Deepgram Aura voice the Assistant speaks with, e.g. aura-2-thalia-en, aura-2-orion-en.',
  voice_stt_model: 'Deepgram model that hears you — the voice pane and Telegram voice notes alike. nova-3 is the current general model; nova-2 for languages it lacks.',
  voice_wake_word: 'On = the Assistant only answers when it hears one of the wake words (and for a few seconds after). Off = it answers everything it hears.',
  voice_wake_words: 'Words that address the Assistant when wake is on, comma-separated.',
  voice_wake_timeout: 'Seconds of silence after the wake word before it is needed again. Any speech — yours or the Assistant\'s — restarts the clock.',
  auto_plan: 'Cards in plan are driven by the supervisor: it has the coding agent write a plan, verifies it, and moves the card to in progress. Each card\'s own Auto plan switch overrides this default.',
  auto_build: 'Cards in progress are driven by the supervisor: it prompts the coding agent, verifies the work against the repo, and moves the card. Each card\'s own Auto build switch overrides this default.',
  loop_budget_tokens: 'Maximum tokens one card run may spend — input + output summed across both agents\' sessions; cache reads and writes not counted. Checked between turns; exceeding it blocks the card. Empty = no limit.',
  supervisor_provider: 'The AI provider the supervisor judges on, on its key from /keys. Empty = the coding agent\'s provider.',
  supervisor_model: 'Model the supervisor judges with. Empty = the coding agent\'s model; required when the provider differs from the coding agent\'s.',
  supervisor_base_url: 'Endpoint when the supervisor\'s provider is openai-compatible. Empty inherits the coding agent\'s only while the provider matches.',
  boot_last_workspace: 'On, launching the cli skips the workspace picker: it starts a new session in the workspace of the most recent session you drove yourself (looper-run sessions do not count). --resume is unaffected.',
  telegram_enabled: 'Answer Telegram DMs. Needs the telegram_bot_token key, telegram_authorized_user, and a public address (PHANTOM_BACKEND_ADDRESS) — the webhook registers itself when all three are set.',
  telegram_authorized_user: 'Your numeric Telegram user id — the ONE sender the bot answers; everyone else is silently ignored. Get it from @userinfobot.',
  telegram_reply_mode: 'How the bot answers: text, voice (a spoken note, on the Assistant\'s Deepgram voice), or both. Read at the start of each turn.',
  telegram_transcript_echo: 'On, a voice note\'s transcript is posted back as 🎤 "…" before the turn runs, so a misheard word is distinguishable from a misunderstood instruction.',
};

/** Type metadata, one entry per setting — TypeScript forces completeness the
 *  same way DESCRIPTIONS does. Without this a client cannot render an editor:
 *  five settings default to null, so their type is unguessable from the value,
 *  and the legal values of a choice live only in English prose. It is also what
 *  PATCH validates against, so "banana" cannot be stored as a pool size. */
export interface SettingMeta {
  type: 'number' | 'string' | 'boolean';
  /** The heading a settings screen files this under. Lives here so every
   *  client draws the same sections and a new setting must pick one. */
  group: 'sessions' | 'containers' | 'limits' | 'git' | 'model' | 'voice' | 'board' | 'telegram';
  /** What to call this setting on screen. The key is the identifier — it is
   *  what the API and a bug report use — and this is the name a person
   *  reads. It lives here so every client shows the same one. */
  label: string;
  /** Exhaustive legal values. Present => the client renders a picker. */
  choices?: readonly string[];
  /** What to call those values on screen, where the stored ones are cryptic:
   *  `base` and `session` mean nothing on sight. The stored value is unchanged. */
  choiceLabels?: Readonly<Record<string, string>>;
  /** May be cleared to null ("no timeout", "no endpoint"). */
  nullable?: boolean;
  /** Exact shape a string value must take. `choices` covers a closed list;
   *  this covers an open one with a grammar — the history window is any
   *  `<n>.<unit>` git understands, and git ACCEPTS GARBAGE SILENTLY (verified:
   *  `--shallow-since=7.dayz` exits 0 and quietly uses a different window), so
   *  nothing downstream will ever catch a typo. */
  pattern?: RegExp;
  unit?: 'ms' | 'bytes' | 'mb' | 'count';
  min?: number;
}

type Group = SettingMeta['group'];
const ms = (label: string, group: Group, min = 0): SettingMeta => ({ type: 'number', label, group, unit: 'ms', min });
const count = (label: string, group: Group, min = 0): SettingMeta => ({ type: 'number', label, group, unit: 'count', min });
const bytes = (label: string, group: Group): SettingMeta => ({ type: 'number', label, group, unit: 'bytes', min: 1 });

export const META: Record<keyof typeof DEFAULTS, SettingMeta> = {
  spare_clones: count('spare clones', 'sessions', 0),
  maintenance_interval_ms: ms('maintenance interval', 'sessions', 1000),
  spare_clone_refresh_ms: ms('spare clone refresh', 'sessions', 0),
  spare_clone_max_age_ms: ms('spare clone max age', 'sessions', 0),
  session_idle_destroy_ms: ms('session idle cleanup', 'sessions', 0),
  container_idle_ms: ms('container idle timeout', 'containers', 0),
  container_memory_mb: { type: 'number', label: 'container memory limit', group: 'containers', unit: 'mb', min: 128, nullable: true },
  container_cpus: { type: 'number', label: 'container cpu limit', group: 'containers', unit: 'count', min: 1, nullable: true },
  container_pids_limit: { type: 'number', label: 'container process limit', group: 'containers', unit: 'count', min: 16, nullable: true },
  initial_history_depth: { type: 'string', label: 'git history', group: 'git',
    pattern: /^(full|\d+\.(second|minute|hour|day|week|month|year)s?)$/ },
  container_image: { type: 'string', label: 'container image', group: 'containers' },
  container_docker: { type: 'boolean', label: 'docker in the workspace', group: 'containers' },
  bash_timeout_ms: { type: 'number', label: 'command timeout', group: 'limits', unit: 'ms', min: 1 },
  bash_timeout_max_ms: { type: 'number', label: 'command timeout cap', group: 'limits', unit: 'ms', min: 1, nullable: true },
  max_read_bytes: bytes('file read limit', 'limits'),
  max_search_results: count('search result limit', 'limits', 1),
  max_bash_output_bytes: bytes('command output limit', 'limits'),
  session_lock_ttl_ms: ms('session lock timeout', 'sessions', 1000),
  auto_push_on_archive: { type: 'boolean', label: 'auto-push on archive', group: 'git' },
  agent_git_credentials: { type: 'boolean', label: 'agent github access', group: 'git' },
  auto_push_fix_attempts: count('git fixer: fix attempts', 'git', 1),
  git_fixer_provider: { type: 'string', label: 'git fixer: provider', group: 'git', nullable: true,
    choices: ['anthropic', 'openai', 'google', 'openai-compatible'] },
  git_fixer_model: { type: 'string', label: 'git fixer: model', group: 'git', nullable: true },
  git_fixer_base_url: { type: 'string', label: 'git fixer: endpoint', group: 'git', nullable: true },
  card_prefix: { type: 'string', label: 'card number prefix', group: 'board', nullable: true },
  provider: { type: 'string', label: 'provider', group: 'model',
    choices: ['anthropic', 'openai', 'google', 'openai-compatible'] },
  model: { type: 'string', label: 'model', group: 'model' },
  base_url: { type: 'string', label: 'endpoint', group: 'model', nullable: true },
  reasoning: { type: 'string', label: 'reasoning', group: 'model',
    choices: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  max_steps: { type: 'number', label: 'steps per turn', group: 'model', unit: 'count', min: 1, nullable: true },
  assistant_provider: { type: 'string', label: 'assistant provider', group: 'voice', nullable: true,
    choices: ['anthropic', 'openai', 'google', 'openai-compatible'] },
  assistant_model: { type: 'string', label: 'assistant model', group: 'voice', nullable: true },
  assistant_base_url: { type: 'string', label: 'assistant endpoint', group: 'voice', nullable: true },
  voice_enabled: { type: 'boolean', label: 'assistant', group: 'voice' },
  sidebar_width: { type: 'number', label: 'voice pane width', group: 'voice', unit: 'count', min: 10 },
  voice_spoken_voice: { type: 'string', label: 'spoken voice', group: 'voice' },
  voice_stt_model: { type: 'string', label: 'hearing model', group: 'voice' },
  voice_wake_word: { type: 'boolean', label: 'wake word only', group: 'voice' },
  voice_wake_words: { type: 'string', label: 'wake words', group: 'voice' },
  voice_wake_timeout: { type: 'number', label: 'wake timeout', group: 'voice', unit: 'count', min: 1 },
  auto_plan: { type: 'boolean', label: 'auto plan', group: 'board' },
  auto_build: { type: 'boolean', label: 'auto build', group: 'board' },
  loop_budget_tokens: { type: 'number', label: 'loop token budget', group: 'board', unit: 'count', min: 1, nullable: true },
  supervisor_provider: { type: 'string', label: 'supervisor provider', group: 'board', nullable: true,
    choices: ['anthropic', 'openai', 'google', 'openai-compatible'] },
  supervisor_model: { type: 'string', label: 'supervisor model', group: 'board', nullable: true },
  supervisor_base_url: { type: 'string', label: 'supervisor endpoint', group: 'board', nullable: true },
  boot_last_workspace: { type: 'boolean', label: 'boot into last workspace', group: 'sessions' },
  telegram_enabled: { type: 'boolean', label: 'telegram', group: 'telegram' },
  telegram_authorized_user: { type: 'string', label: 'authorized user id', group: 'telegram', nullable: true },
  telegram_reply_mode: { type: 'string', label: 'reply mode', group: 'telegram',
    choices: ['text', 'voice', 'both'] },
  telegram_transcript_echo: { type: 'boolean', label: 'transcript echo', group: 'telegram' },
};

// ONE rule at every layer: null in a PATCH clears the key; null is never
// STORED anywhere (settings rows, workspace columns, session columns alike).
// A nullable setting may therefore only be null via its default — a nullable
// setting with a non-null default would make "off" unsayable, so that
// combination refuses to boot. Future "off" states are real values (0,
// 'none'), never null. Enforced HERE, at module load, not in a test.
for (const k of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
  if (META[k].nullable && DEFAULTS[k] !== null) {
    throw new Error(
      `setting '${k}': nullable requires a null default — null always means "clear", never a stored value`);
  }
}

/** Validate one value against its metadata. Returns null when fine, else why.
 *  The DB is not typed per key, so this is the only thing standing between a
 *  typo and a setting that explodes at its point of use hours later. */
export function validateSetting(key: SettingKey, value: unknown): string | null {
  const m = META[key];
  if (value === null) return `${key}: null clears the key (it is never a stored value)`;
  if (m.choices) {
    return typeof value === 'string' && m.choices.includes(value)
      ? null : `${key} must be one of: ${m.choices.join(', ')}`;
  }
  if (m.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${key} must be a number`;
    if (m.min !== undefined && value < m.min) return `${key} must be >= ${m.min}`;
    return null;
  }
  if (m.type === 'boolean') return typeof value === 'boolean' ? null : `${key} must be true or false`;
  if (typeof value !== 'string') return `${key} must be a string`;
  if (m.pattern && !m.pattern.test(value)) return `${key} is not a valid ${m.label}: "${value}"`;
  return null;
}

/** Validate a whole {key: value} patch. null is a CLEAR, not a value, so it is
 *  never validated — the caller deletes those. Returns the messages, empty when
 *  fine.
 *
 *  Both write paths call this. They used not to: PATCH /settings validated and
 *  PATCH /workspaces/:id did not, so the same value was refused globally and
 *  stored per workspace — and `session_idle_destroy_ms: -1` there made every
 *  session in the workspace instantly idle, so the next sweep deleted every
 *  clone. A second write path is a second place to forget. */
export function validatePatch(entries: Array<[string, unknown]>): string[] {
  return entries
    .filter(([, v]) => v !== null)
    .map(([k, v]) => (isSettingKey(k) ? validateSetting(k, v) : null))
    .filter((m): m is string => m !== null);
}

export type SettingKey = keyof typeof DEFAULTS;
export type SettingValue = (typeof DEFAULTS)[SettingKey];

export function isSettingKey(k: string): k is SettingKey {
  return Object.prototype.hasOwnProperty.call(DEFAULTS, k);
}

// Which settings a workspace / session row can override, and through which
// column. The chain is: code default -> settings row -> workspace -> session.
/** Which scopes a setting may be set at, beyond `global`. It used to be two
 *  hand-kept maps from key to column; now a workspace override is a row like any
 *  other, so this is the whole declaration. A PATCH at a scope a key does not
 *  accept is refused. */
const SCOPED: Partial<Record<SettingKey, Array<'workspace' | 'session'>>> = {
  spare_clones: ['workspace'],
  session_idle_destroy_ms: ['workspace', 'session'],
  initial_history_depth: ['workspace'],
  container_image: ['workspace'],
  container_docker: ['workspace'],
  auto_push_on_archive: ['workspace', 'session'],
  agent_git_credentials: ['workspace'],
  card_prefix: ['workspace'],
  auto_plan: ['workspace'],
  auto_build: ['workspace'],
  loop_budget_tokens: ['workspace'],
};

/** Which settings a single workspace can differ on. Derived from the same
 *  declaration resolve() acts on, so it cannot drift from it. */
export const WORKSPACE_OVERRIDABLE = (Object.keys(SCOPED) as SettingKey[])
  .filter((k) => SCOPED[k]!.includes('workspace'));

/** Settings that are a fact about ONE workspace — a card prefix names one
 *  board — so a global value is meaningless. Never settable at the global
 *  layer, and GET /settings leaves them off the global list. */
const WORKSPACE_ONLY: readonly SettingKey[] = ['card_prefix'];
export const isGlobalSettable = (k: SettingKey) => !WORKSPACE_ONLY.includes(k);
export const isWorkspaceOverridable = (k: SettingKey) => !!SCOPED[k]?.includes('workspace');
export const isSessionOverridable = (k: SettingKey) => !!SCOPED[k]?.includes('session');

/** Credentials are scoped too: a workspace may hold its own GitHub token, which
 *  is what makes the credential chain (workspace -> global -> none) the SAME
 *  chain as every other setting rather than a hand-written copy of it. */
export const isCredentialWorkspaceScoped = (k: string) => k === 'github_token';

export type Source = 'default' | 'override' | 'workspace' | 'session';

export interface ResolveCtx { workspace?: WorkspaceRow; session?: SessionRow }

/** One setting with its LAYERS exposed, not just the winner — what a client
 *  needs to render an editor (VS Code's inspect(), git's --show-origin):
 *  `default` (code), `global` (the settings row, null when unset), `workspace`
 *  and `session` (their overrides, null when unset or no such context), then
 *  the computed `value` + `source`. */
export interface SettingLayers {
  default: unknown;
  global: unknown;
  workspace: unknown;
  session: unknown;
  value: unknown;
  source: Source;
}

/** THE precedence rule, written once: default → settings row → workspace
 *  column → session column. Null is never stored at any layer (null in a
 *  PATCH clears; legacy stored nulls were purged long ago), so row presence
 *  and column non-null both simply mean "set". Everything that resolves a
 *  setting reads its answer off this. */
function computeLayers(key: SettingKey, layers: RawLayers): SettingLayers {
  let value: unknown = DEFAULTS[key];
  let source: Source = 'default';
  // Row PRESENCE decides at every level — null is never a stored value,
  // so "there is a row" and "there is an override" are the same statement.
  if (layers.global !== undefined) { value = layers.global; source = 'override'; }
  if (layers.workspace !== undefined) { value = layers.workspace; source = 'workspace'; }
  if (layers.session !== undefined) { value = layers.session; source = 'session'; }
  return {
    default: DEFAULTS[key],
    global: layers.global ?? null,
    workspace: layers.workspace ?? null,
    session: layers.session ?? null,
    value, source,
  };
}

interface RawLayers { global?: unknown; workspace?: unknown; session?: unknown }

/** The scopes to read for a context, in order. `resolve` and `settingsLayers`
 *  both go through here so neither can look at a different set. */
function scopesFor(ctx: ResolveCtx): string[] {
  const out = [GLOBAL];
  if (ctx.workspace) out.push(workspaceScope(ctx.workspace.id));
  if (ctx.session) out.push(sessionScope(ctx.session.id));
  return out;
}

function layersFrom(byScope: Map<string, Map<string, { value: unknown }>>, ctx: ResolveCtx, key: string): RawLayers {
  const at = (scope: string) => byScope.get(scope)?.get(key)?.value;
  return {
    global: at(GLOBAL),
    workspace: ctx.workspace ? at(workspaceScope(ctx.workspace.id)) : undefined,
    session: ctx.session ? at(sessionScope(ctx.session.id)) : undefined,
  };
}

export async function resolveWithSource<K extends SettingKey>(
  db: Db, key: K, ctx: ResolveCtx = {},
): Promise<{ value: unknown; source: Source }> {
  const byScope = await readStore(db, null, scopesFor(ctx));
  const { value, source } = computeLayers(key, layersFrom(byScope, ctx, key));
  return { value, source };
}

export async function resolve<K extends SettingKey>(
  db: Db, key: K, ctx: ResolveCtx = {},
): Promise<(typeof DEFAULTS)[K]> {
  return (await resolveWithSource(db, key, ctx)).value as (typeof DEFAULTS)[K];
}

/** Several settings from ONE read. `resolve` per key was one query per key, and
 *  the hot paths ask for three to five at a time — a tool call, a pool tick, an
 *  auto-push tick. */
export async function resolveMany<K extends SettingKey>(
  db: Db, keys: readonly K[], ctx: ResolveCtx = {},
): Promise<{ [P in K]: (typeof DEFAULTS)[P] }> {
  const byScope = await readStore(db, null, scopesFor(ctx));
  const out = {} as { [P in K]: (typeof DEFAULTS)[P] };
  for (const k of keys) out[k] = computeLayers(k, layersFrom(byScope, ctx, k)).value as (typeof DEFAULTS)[K] as never;
  return out;
}

/** A credential, resolved through the SAME chain: workspace -> global -> none.
 *  The GitHub credential chain used to be written out by hand in pool.ts; it is
 *  this call now. */
export async function resolveCredential(
  db: Db, key: Buffer, name: CredentialName, ctx: ResolveCtx = {},
): Promise<string | undefined> {
  const byScope = await readStore(db, key, scopesFor(ctx));
  const l = layersFrom(byScope as never, ctx, name);
  const v = l.session ?? l.workspace ?? l.global;
  return typeof v === 'string' && v.length ? v : undefined;
}

/** Every setting's layers for one context, from ONE read. */
export async function settingsLayers(
  db: Db, ctx: ResolveCtx,
): Promise<Record<SettingKey, SettingLayers>> {
  const byScope = await readStore(db, null, scopesFor(ctx));
  const out = {} as Record<SettingKey, SettingLayers>;
  for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
    out[key] = computeLayers(key, layersFrom(byScope, ctx, key));
  }
  return out;
}

/** A setting's layers PLUS what a client needs to render it. The one shape
 *  every route serving settings returns. */
export type SettingEntry = SettingLayers & {
  description: string; meta: SettingMeta; overridable: boolean;
};

/** Layers + description + meta + overridable, for every setting. */
export async function settingsBlock(
  db: Db, ctx: ResolveCtx,
): Promise<Record<SettingKey, SettingEntry>> {
  const layers = await settingsLayers(db, ctx);
  const out = {} as Record<SettingKey, SettingEntry>;
  for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
    out[key] = { ...layers[key], description: DESCRIPTIONS[key], meta: META[key],
      overridable: isWorkspaceOverridable(key) };
  }
  return out;
}
