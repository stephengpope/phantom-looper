// Settings resolution. Defaults live HERE, in code — the database holds only
// explicit overrides, so a new setting ships working with no migration and
// "unset" stays distinct from "set to the current default" (unset follows the
// default when it changes; an override does not).
//
// Read at the point of use, never cached at boot: a settings change must take
// effect without a restart or the config API lies.
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { settings, type WorkspaceRow } from './db/schema.js';
import { GLOBAL, workspaceScope } from './store.js';
import { encrypt, decrypt } from './crypto.js';
import { latestModel } from './models.js';
import { PROVIDERS, REASONINGS, type Provider } from '../core/llm/createAgent.js';
import { Clock, TIMEZONES } from '../core/clock.js';
import { agentConfigFrom, resolveModel, type AgentConfig, type AgentName, type AgentRows, type ModelPin } from './agentConfig.js';
import { APP_VERSION } from './env.js';
import { logger } from './log.js';
import type { SettingsEvents } from './api/settingsEvents.js';

const log = logger('settings');

// Plain settings are never encrypted, so resolving one reads plain values
// only — a credential is read by `credential`, which is handed the name
// explicitly and is the only path that decrypts one.

// The workspace image default tracks THIS server's release: a tagged build
// names the workspace image at the same tag (both are published together by
// the release workflow), a dev build names :latest (scripts/setup.sh builds
// it locally under that tag). Pulled on first use — see container.ts.
const SESSION_IMAGE_TAG = /^v\d+\.\d+\.\d+/.test(APP_VERSION) ? APP_VERSION : 'latest';

export const DEFAULTS = {
  // Declaration order is screen order: the three agents, then the areas.
  //
  // ── coding agent ──────────────────────────────────────────────────────────
  // ONE store: the cli and the server's looper read the same rows, which is
  // what makes "the experience is the same" literal. NO default provider:
  // nothing runs until a person picks one (the wizard, /settings). The model's
  // default is not a constant either — unset, it resolves to the newest
  // model the catalog lists for the provider (models.ts, applied in
  // computeLayersFor), so it follows releases.
  coding_provider: null as string | null,
  coding_model: null as string | null,
  coding_base_url: null as string | null,
  coding_reasoning: 'medium' as string,
  coding_max_steps: null as number | null,
  // Compaction: auto-summarize when the session approaches the model's
  // context window. The assistant's and supervisor's fall back to the coding
  // agent's, like their model.
  coding_context_window: null as number | null,              // fallback when the catalog doesn't know the model
  coding_compact_threshold_pct: 0 as number,                 // % of context window that triggers compaction; 0 = off
  coding_compact_strategy: 'fast' as string,
  coding_compact_summarize_pct: 75 as number,                // % of user+assistant messages to summarize
  coding_compact_max_tokens: null as number | null,          // output cap for the summary; null = model decides
  // ── the Assistant ─────────────────────────────────────────────────────────
  // Its model — null = the coding agent's (the cascade, agentConfig.ts).
  assistant_provider: null as string | null,
  assistant_model: null as string | null,
  assistant_base_url: null as string | null,
  assistant_reasoning: null as string | null,
  assistant_max_steps: null as number | null,
  assistant_context_window: null as number | null,
  assistant_compact_threshold_pct: 50 as number,      // on by default for the assistant
  assistant_compact_strategy: 'fast' as string,
  assistant_compact_summarize_pct: null as number | null,
  assistant_compact_max_tokens: null as number | null,
  // Its voice and pane — rendered by the cli, stored here so every cli you
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
  // ── the supervisor ────────────────────────────────────────────────────────
  // Its model — null = the coding agent's (cascade rule).
  supervisor_provider: null as string | null,
  supervisor_model: null as string | null,
  supervisor_base_url: null as string | null,
  supervisor_reasoning: null as string | null,
  supervisor_max_steps: null as number | null,
  supervisor_context_window: null as number | null,
  supervisor_compact_threshold_pct: null as number | null,
  supervisor_compact_strategy: null as string | null,
  supervisor_compact_summarize_pct: null as number | null,
  supervisor_compact_max_tokens: null as number | null,
  // ── general ───────────────────────────────────────────────────────────────
  // The builder's time zone — what every date the system shows or reads is
  // in (cron schedules, the token report's "today", the agents' current
  // date). Settings.clock() is the door (core/clock.ts).
  timezone: 'UTC' as string,
  // ── board ─────────────────────────────────────────────────────────────────
  // The looper: the supervisor loop over kanban cards — TWO switches, one per
  // loop column (a card's own auto_plan/auto_build tri-state overrides them).
  auto_plan: false as boolean,
  auto_build: false as boolean,
  loop_budget_tokens: null as number | null,   // null = no limit
  card_prefix: null as string | null,   // unset => derived from the repo name; workspace-only
  // ── crons ─────────────────────────────────────────────────────────────────
  // Scheduled prompts (crons.ts, crons/engine.ts): each opens a new coding
  // session in its workspace and runs one turn. The master switch pauses a
  // workspace's crons without touching each one.
  cron_enabled: true as boolean,
  // ── sessions ──────────────────────────────────────────────────────────────
  spare_clones: 2,
  maintenance_interval_ms: 60_000,
  spare_clone_refresh_ms: 3_600_000,        // performance only — the claim fetch is the guarantee
  spare_clone_max_age_ms: 7 * 24 * 3_600_000, // evict and re-stock rather than re-deepen
  disk_cleanup_percent: 80,
  session_lock_ttl_ms: 3_600_000,
  // The cli's boot: skip the workspace picker, start where you last worked.
  boot_last_workspace: true as boolean,
  // ── containers ────────────────────────────────────────────────────────────
  container_idle_ms: 4320 * 60_000,
  container_memory_mb: null as number | null, // unset => no cap (Docker default)
  container_cpus: null as number | null,      // unset => no cap (Docker default)
  container_pids_limit: null as number | null, // unset => no cap (Docker default)
  container_image: `ghcr.io/stephengpope/phantom-backend-session:${SESSION_IMAGE_TAG}` as string,
  container_docker: true as boolean, // privileged + a graph-storage volume so the agent can run its OWN dockerd inside
  agent_database: false as boolean,  // the agent's own Postgres database for this workspace, reached only through its database_query tool
  // The repo's root SOUL.md, frozen into the coding agent's prompt at session
  // birth (read from the checkout, like the skills). Off says nothing.
  agent_soul: false as boolean,
  // ── git ───────────────────────────────────────────────────────────────────
  initial_history_depth: '7.days',   // 'full' disables shallow
  auto_push_on_archive: true as boolean,
  agent_git_credentials: false as boolean,
  // Instant sync (git/instantSync.ts): a workspace switch that turns the
  // on-demand auto-push / auto-pull into a continuous one — a file watcher
  // pushes after a quiet spell, a timer pulls base in. The switch is
  // workspace-only (a notes repo wants it, a code repo usually does not);
  // the two timings are global with a workspace override.
  instant_sync: false as boolean,
  instant_sync_push_debounce_ms: 30_000,
  instant_sync_pull_interval_ms: 5_000,
  // ── limits ────────────────────────────────────────────────────────────────
  bash_timeout_ms: 120_000 as number | null,   // two minutes, as OpenCode; the agent passes a longer one per command
  bash_timeout_max_ms: null as number | null,
  max_read_bytes: 262_144,
  max_search_results: 200,
  max_bash_output_bytes: 1_048_576,
  // ── telegram ──────────────────────────────────────────────────────────────
  // The bot as a client of this server (phantom-backend/telegram/). The
  // webhook URL is never a setting — it is always https://
  // PHANTOM_BACKEND_ADDRESS, the same fact the https profile runs on.
  telegram_enabled: false as boolean,
  telegram_authorized_user: null as string | null,
  telegram_reply_mode: 'text' as string,
  telegram_transcript_echo: false as boolean,
  // A DM when the LOOP moves a card into in_progress / blocked / done — the
  // automated work, seen from the phone. Workspace-overridable.
  telegram_auto_build_notifications: true as boolean,
  // How often to send a digest of sessions that finished. Minutes; 0 = off.
  // Sessions idle longer than this are included. Sent to all notification
  // channels (Telegram today, Slack/Teams later).
  session_digest_interval: 5 as number,
  // How often the server checks GitHub for a new release and notifies via
  // Telegram. 0 disables the check entirely.
  update_check_interval_ms: 86_400_000 as number,   // 24 hours
} as const;

/** The credentials the SERVER holds, declared here so nothing can store one in
 *  the clear by forgetting a flag. Named the way each vendor names it: GitHub
 *  says token, everyone else says API key. Label, group and description are
 *  served by GET /settings — the ONE place a credential is described, as
 *  DESCRIPTIONS is for settings; the cli's /keys renders them verbatim.
 *
 *  There is no per-agent api key. An agent holds a key FOR a provider, and
 *  which provider is its own `*_provider` setting — so it reads the key for
 *  whatever that says, the same row the TUI's own agent reads. One key per
 *  provider, one place to set it. */
export interface CredentialMeta {
  label: string; group: 'git' | 'llm' | 'voice' | 'search' | 'chat'; description: string;
  /** The LLM provider this key authenticates — the ONE declaration of which
   *  row holds which provider's key. Served on the wire (`meta.provider`), so
   *  the cli's screens and the server's agent builder read the same fact. */
  provider?: Provider;
}
export const CREDENTIALS = {
  github_token: { label: 'github token', group: 'git',
    description: 'Lets phantom-looper manage GitHub repos: clone, push, and land work on the base branch. A workspace can hold its own token; otherwise this one is used.' },
  anthropic_api_key: { label: 'anthropic key', group: 'llm', provider: 'anthropic', description: 'Used by every agent set to the anthropic provider.' },
  openai_api_key: { label: 'openai key', group: 'llm', provider: 'openai', description: 'Used by every agent set to the openai provider.' },
  google_api_key: { label: 'google key', group: 'llm', provider: 'google', description: 'Used by every agent set to the google provider (Gemini).' },
  deepseek_api_key: { label: 'deepseek key', group: 'llm', provider: 'deepseek', description: 'Used by every agent set to the deepseek provider.' },
  kimi_api_key: { label: 'kimi key', group: 'llm', provider: 'kimi', description: 'Used by every agent set to the kimi provider (Moonshot AI / Kimi).' },
  xai_api_key: { label: 'xai key', group: 'llm', provider: 'xai', description: 'Used by every agent set to the xai provider (Grok).' },
  mistral_api_key: { label: 'mistral key', group: 'llm', provider: 'mistral', description: 'Used by every agent set to the mistral provider.' },
  groq_api_key: { label: 'groq key', group: 'llm', provider: 'groq', description: 'Used by every agent set to the groq provider.' },
  openai_compatible_api_key: { label: 'openai-compatible key', group: 'llm', provider: 'openai-compatible',
    description: 'For OpenAI-compatible endpoints — Ollama, vLLM, OpenRouter. Not the same key as OpenAI.' },
  deepgram_api_key: { label: 'deepgram key', group: 'voice',
    description: 'Speech to text and text to speech for the Assistant. Without it the Assistant has no voice.' },
  firecrawl_api_key: { label: 'firecrawl key', group: 'search',
    description: 'Powers the web_search and web_fetch tools; without it web calls fail. Keys at firecrawl.dev.' },
  telegram_bot_token: { label: 'telegram bot token', group: 'chat',
    description: 'The Telegram bot\'s token from @BotFather. With telegram enabled and an authorized user set (/settings), saving it registers the webhook.' },
} satisfies Record<string, CredentialMeta>;

export type CredentialName = keyof typeof CREDENTIALS;
export const CREDENTIAL_NAMES = Object.keys(CREDENTIALS) as CredentialName[];
export const isCredential = (k: string): k is CredentialName =>
  Object.prototype.hasOwnProperty.call(CREDENTIALS, k);

/** The row holding one provider's API key, read off CREDENTIALS' `provider`
 *  field. undefined for a provider that holds no key here (openai-codex reads
 *  its own login file). */
export const credentialForProvider = (p: string): CredentialName | undefined =>
  CREDENTIAL_NAMES.find((n) => (CREDENTIALS[n] as CredentialMeta).provider === p);

/** What each setting does, in one or two plain sentences — and, where it
 *  matters, WHEN a change starts applying. Served by GET /settings and
 *  rendered verbatim by the TUI: this is the ONE place a setting's meaning is
 *  written down. A client that needed its own friendlier copy would be a
 *  second source to keep in step, and the two would drift — fix a bad line
 *  here. */
export const DESCRIPTIONS: Record<keyof typeof DEFAULTS, string> = {
  spare_clones: 'Clones of the repo kept ready and waiting. A new session takes one instead of waiting for a clone. Each one costs disk.',
  maintenance_interval_ms: 'How often the maintenance loop runs — restocking spare clones, backing up idle sessions, stopping idle containers, disk cleanup. Every other "after this long" setting is only checked this often.',
  spare_clone_refresh_ms: 'A spare clone older than this is brought up to date in the background. Speed only: a session always fetches when it takes one.',
  spare_clone_max_age_ms: 'A spare clone older than this is thrown away and cloned fresh.',
  disk_cleanup_percent: 'Reclaim disk when the workspace drive passes this percent full: images from older releases first, then the files of idle folders (past the container idle timeout), oldest first — each backed up to its branch on GitHub before its files are deleted, so nothing is lost and reopening the session just re-clones. Never a running container, a spare clone or a newer image. 0 disables.',
  container_idle_ms: 'How long a container sits unused before it is stopped. The next tool call starts a fresh one, costing a second or two. This is also when a changed image or token setting takes effect.',
  container_memory_mb: 'Unset (the default) means no cap — the container uses what the host allows. Set it only to protect a shared host; too low and builds and tests get killed part-way through.',
  container_cpus: 'Unset (the default) means no cap. Set it only to keep one session from starving others on a shared host; fewer cores makes work slower, not impossible.',
  container_pids_limit: 'Unset (the default) means no cap. Set it only as fork-bomb protection on a shared host; too low and a normal parallel build hits it.',
  initial_history_depth: "How much git history a new clone gets — a span like '7.days', or 'full' for all of it. Less means a faster clone and less disk, but the agent cannot see past it. Fixed when the clone is made.",
  container_image: 'Must contain ripgrep. Pulled the first time a session needs it; a change applies when the container next restarts.',
  container_docker: 'Lets the agent run Docker inside its own container. The container gets privileged mode and a native-overlay graph-storage volume, but the daemon is NOT started for you — the agent runs `start-docker` when it wants it, so idle sessions pay nothing. Privileged is a weaker boundary: turn this off for a hardened workspace. Applies when the container next restarts.',
  agent_database: 'Gives the agent its own PostgreSQL database for this workspace — private to it, kept across sessions, reached only through its database_query tool (never by the project\'s code). The agent is its admin but cannot drop it. Off keeps the data; deleting the workspace deletes it.',
  agent_soul: 'Puts the repo\'s root SOUL.md into the coding agent\'s system prompt, read from the checkout when a session starts and frozen with it — so an edit reaches new sessions only. A repo without the file adds nothing.',
  bash_timeout_ms: 'Kills a command that set no timeout of its own; the agent can ask for a longer one per command.',
  bash_timeout_max_ms: 'The longest timeout the agent may request for one command. Unset means no limit.',
  max_read_bytes: 'Cap on bytes returned per file read. Bigger files are read in chunks — nothing is hidden, it just takes more calls.',
  max_search_results: 'Cap on hits returned per search; the true total is still reported.',
  max_bash_output_bytes: 'Cap on output kept per command; anything past it is dropped.',
  session_lock_ttl_ms: 'How long a session stays held after its holder goes quiet. A turn the server itself is running is never handed away on this clock — it is checked directly — so this only covers a client that died holding a session (a closed laptop, a killed window).',
  auto_push_on_archive: 'Archiving a done card auto-pushes its session\'s work to the base branch; a failed push un-archives the card into blocked. Archiving from any other column never pushes.',
  agent_git_credentials: 'Puts the GitHub token inside the container so the agent can run git and gh itself — the agent can then read it. Applies when the container restarts; off does not reclaim it from a running one.',
  instant_sync: 'Keeps every running session in this workspace in step with the base branch on its own: a file change auto-pushes after the debounce, and base is checked with a plain git fetch on the pull interval and auto-pulled when it moved. Runs whether or not a turn is running and never fixes a conflict itself — the agent is told and resolves it. Best for a notes or second-brain repo. Takes effect at once.',
  instant_sync_push_debounce_ms: 'How long the files must stay quiet after a change before instant sync pushes.',
  instant_sync_pull_interval_ms: 'How often instant sync fetches the base branch to see whether it moved. A plain git fetch — it never touches the GitHub API rate limit. Shorter means other sessions\' work arrives sooner.',
  timezone: 'Your time zone — an IANA name like America/New_York or Europe/London. Every date the system shows or reads is in it: a cron\'s "0 9 * * *" is 9am here, the token report\'s "today" starts at midnight here, and the agents are told today\'s date here.',
  card_prefix: 'The letters in front of every card number on this board — "PHA" gives PHA-7. Unset means the first three letters of the repo name.',
  cron_enabled: 'Scheduled prompts (crons) for this workspace. Off: none fire, and the agents lose their cron tools; the crons themselves are kept. A slot missed while off is not made up.',
  coding_provider: 'The coding agent\'s LLM provider. Its key is set on /keys. Nothing runs until one is chosen.',
  coding_model: 'Model id for the chosen provider. Empty = the newest model the catalog lists for it, so it follows releases.',
  coding_base_url: 'Endpoint for openai / openai-compatible. Required by openai-compatible.',
  coding_reasoning: 'How much the model thinks before answering. Providers map this to their own setting.',
  coding_max_steps: 'Tool calls allowed per turn before the agent must stop and answer. Empty = unlimited.',
  assistant_provider: 'The AI provider the Assistant answers on, on its key from /keys. Empty = the coding agent\'s provider.',
  assistant_model: 'Model the Assistant answers with. Empty = the coding agent\'s model; required when the provider differs from the coding agent\'s. A small fast model keeps replies quick.',
  assistant_base_url: 'Endpoint when the Assistant\'s provider is openai-compatible. Empty inherits the coding agent\'s only while the provider matches.',
  assistant_reasoning: 'How much the Assistant thinks before answering. Empty = the coding agent\'s reasoning level.',
  assistant_max_steps: 'Tool calls allowed per turn for the Assistant. Empty = unlimited.',
  coding_context_window: 'Context window size in tokens — fallback for when the model catalog doesn\'t know your model. Empty = use the catalog (the normal path).',
  coding_compact_threshold_pct: 'Percentage of the model\'s context window that triggers auto-compaction. 0 = off. Checked after every turn.',
  coding_compact_strategy: 'The compaction strategy. fast = user/assistant text only.',
  coding_compact_summarize_pct: 'Percentage of user+assistant messages to summarize when compaction fires. The rest stay as-is.',
  coding_compact_max_tokens: 'Output token cap for the compaction summary. Empty = the model decides how long the summary is.',
  assistant_context_window: 'Context window override for the Assistant. Empty = the coding agent\'s context window.',
  assistant_compact_threshold_pct: 'Auto-compaction threshold for the Assistant. 0 = off. Default 50%.',
  assistant_compact_strategy: 'Compaction strategy for the Assistant. Empty = the coding agent\'s strategy.',
  assistant_compact_summarize_pct: 'Summarize % for the Assistant. Empty = the coding agent\'s summarize %.',
  assistant_compact_max_tokens: 'Summary output cap for the Assistant. Empty = the coding agent\'s cap.',
  supervisor_context_window: 'Context window override for the Supervisor. Empty = the coding agent\'s context window.',
  supervisor_compact_threshold_pct: 'Auto-compaction threshold for the Supervisor. Empty = the coding agent\'s threshold.',
  supervisor_compact_strategy: 'Compaction strategy for the Supervisor. Empty = the coding agent\'s strategy.',
  supervisor_compact_summarize_pct: 'Summarize % for the Supervisor. Empty = the coding agent\'s summarize %.',
  supervisor_compact_max_tokens: 'Summary output cap for the Supervisor. Empty = the coding agent\'s cap.',
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
  supervisor_reasoning: 'How much the supervisor thinks before answering. Empty = the coding agent\'s reasoning level.',
  supervisor_max_steps: 'Tool calls allowed per turn for the supervisor. Empty = unlimited.',
  boot_last_workspace: 'On (the default), launching the cli skips the workspace picker: it starts a new session in the workspace of the most recent session you drove yourself (looper-run sessions do not count). Off, launching opens the picker. --resume is unaffected.',
  telegram_enabled: 'Answer Telegram DMs. Needs the telegram_bot_token key, telegram_authorized_user, and a public address (PHANTOM_BACKEND_ADDRESS) — the webhook registers itself when all three are set.',
  telegram_authorized_user: 'Your numeric Telegram user id — the ONE sender the bot answers; everyone else is silently ignored. Get it from @userinfobot.',
  telegram_reply_mode: 'How the bot answers: text, voice (a spoken note, on the Assistant\'s Deepgram voice), or both. Read at the start of each turn.',
  telegram_transcript_echo: 'On, a voice note\'s transcript is posted back as 🎤 "…" before the turn runs, so a misheard word is distinguishable from a misunderstood instruction.',
  telegram_auto_build_notifications: 'A message when the loop moves a card to in progress, blocked, or done. Moves made by people are never announced. Reply to one to enter the card\'s coding session. Per workspace: override on the workspace.',
  session_digest_interval: 'How often (minutes) to send a digest of sessions that finished their turn. 0 disables it. Sessions idle longer than this interval are included.',
  update_check_interval_ms: 'How often the server checks GitHub for a new release and sends a Telegram notification. 0 disables the check. The check runs only when Telegram is enabled and an authorized user is set.',
};

/** Type metadata, one entry per setting — TypeScript forces completeness the
 *  same way DESCRIPTIONS does. Without this a client cannot render an editor:
 *  five settings default to null, so their type is unguessable from the value,
 *  and the legal values of a choice live only in English prose. It is also what
 *  PATCH validates against, so "banana" cannot be stored as a pool size. */
export interface SettingMeta {
  type: 'number' | 'string' | 'boolean';
  /** The heading a settings screen files this under — an agent, or an
   *  area. Lives here so every client draws the same sections and a new
   *  setting must pick one. */
  group: 'coding' | 'assistant' | 'supervisor' | 'general' | 'board' | 'crons' | 'sessions' | 'containers' | 'git' | 'limits' | 'telegram';
  /** The sub-heading inside an agent's group. */
  subgroup?: 'model' | 'compaction' | 'voice';
  /** What to call this setting on screen. The key is the identifier — it is
   *  what the API and a bug report use — and this is the name a person
   *  reads, under its group heading (so `coding_provider` is "provider"
   *  under "coding"). It lives here so every client shows the same one. */
  label: string;
  /** Exhaustive legal values. Present => the client renders a picker. */
  choices?: readonly string[];
  /** What to call those values on screen, where the stored ones are cryptic:
   *  `base` and `session` mean nothing on sight. The stored value is unchanged. */
  choiceLabels?: Readonly<Record<string, string>>;
  /** May be cleared to null ("no timeout", "no endpoint"). */
  nullable?: boolean;
  max?: number;
  /** Exact shape a string value must take. `choices` covers a closed list;
   *  this covers an open one with a grammar — the history window is any
   *  `<n>.<unit>` git understands, and git ACCEPTS GARBAGE SILENTLY (verified:
   *  `--shallow-since=7.dayz` exits 0 and quietly uses a different window), so
   *  nothing downstream will ever catch a typo. */
  pattern?: RegExp;
  /** A string check no grammar can express — the value must name something
   *  that exists (a time zone). Returns why it is refused, or null. */
  check?: (value: string) => string | null;
  /** The values to offer for an open string — the cli draws a field that
   *  filters this list as you type (the model catalog's combobox). Not a
   *  closed set like `choices`: `check` is what refuses a value off it. */
  suggestions?: readonly string[];
  unit?: 'ms' | 'bytes' | 'mb' | 'count';
  min?: number;
}

type Group = SettingMeta['group'];
/** A zone off the Clock's list is refused: a typo stored here would make
 *  every cron in the workspace fail at its tick. */
const checkTimezone = (v: string): string | null =>
  TIMEZONES.includes(v) ? null
    : `timezone must be an IANA time zone name like America/New_York or Europe/London (got "${v}")`;
const ms = (label: string, group: Group, min = 0): SettingMeta => ({ type: 'number', label, group, unit: 'ms', min });
const count = (label: string, group: Group, min = 0): SettingMeta => ({ type: 'number', label, group, unit: 'count', min });
const bytes = (label: string, group: Group): SettingMeta => ({ type: 'number', label, group, unit: 'bytes', min: 1 });

export const META: Record<keyof typeof DEFAULTS, SettingMeta> = {
  spare_clones: count('spare clones', 'sessions', 0),
  maintenance_interval_ms: ms('maintenance interval', 'sessions', 1000),
  spare_clone_refresh_ms: ms('spare clone refresh', 'sessions', 0),
  spare_clone_max_age_ms: ms('spare clone max age', 'sessions', 0),
  disk_cleanup_percent: { type: 'number', label: 'disk cleanup', group: 'sessions', unit: 'count', min: 0, max: 100 },
  container_idle_ms: ms('container idle timeout', 'containers', 0),
  container_memory_mb: { type: 'number', label: 'container memory limit', group: 'containers', unit: 'mb', min: 128, nullable: true },
  container_cpus: { type: 'number', label: 'container cpu limit', group: 'containers', unit: 'count', min: 1, nullable: true },
  container_pids_limit: { type: 'number', label: 'container process limit', group: 'containers', unit: 'count', min: 16, nullable: true },
  initial_history_depth: { type: 'string', label: 'git history', group: 'git',
    pattern: /^(full|\d+\.(second|minute|hour|day|week|month|year)s?)$/ },
  container_image: { type: 'string', label: 'container image', group: 'containers' },
  container_docker: { type: 'boolean', label: 'docker in the workspace', group: 'containers' },
  // Under containers: it is a service stood up beside the session container.
  agent_database: { type: 'boolean', label: 'agent database', group: 'containers' },
  agent_soul: { type: 'boolean', label: 'SOUL.md in the prompt', group: 'coding' },
  bash_timeout_ms: { type: 'number', label: 'command timeout', group: 'limits', unit: 'ms', min: 1 },
  bash_timeout_max_ms: { type: 'number', label: 'command timeout cap', group: 'limits', unit: 'ms', min: 1, nullable: true },
  max_read_bytes: bytes('file read limit', 'limits'),
  max_search_results: count('search result limit', 'limits', 1),
  max_bash_output_bytes: bytes('command output limit', 'limits'),
  session_lock_ttl_ms: ms('session lock timeout', 'sessions', 1000),
  auto_push_on_archive: { type: 'boolean', label: 'auto-push on archive', group: 'git' },
  // Under git, beside the token it hands over — not under agent.
  agent_git_credentials: { type: 'boolean', label: 'agent github access', group: 'git' },
  instant_sync: { type: 'boolean', label: 'instant sync', group: 'git' },
  instant_sync_push_debounce_ms: ms('instant sync push debounce', 'git'),
  instant_sync_pull_interval_ms: ms('instant sync pull interval', 'git'),
  card_prefix: { type: 'string', label: 'card number prefix', group: 'board', nullable: true },
  timezone: { type: 'string', label: 'time zone', group: 'general', check: checkTimezone, suggestions: TIMEZONES },
  cron_enabled: { type: 'boolean', label: 'crons', group: 'crons' },
  coding_provider: { type: 'string', label: 'provider', group: 'coding', subgroup: 'model', nullable: true, choices: PROVIDERS },
  coding_model: { type: 'string', label: 'model', group: 'coding', subgroup: 'model', nullable: true },
  coding_base_url: { type: 'string', label: 'endpoint', group: 'coding', subgroup: 'model', nullable: true },
  coding_reasoning: { type: 'string', label: 'reasoning', group: 'coding', subgroup: 'model', choices: REASONINGS },
  coding_max_steps: { type: 'number', label: 'steps per turn', group: 'coding', subgroup: 'model', unit: 'count', min: 1, nullable: true },
  assistant_provider: { type: 'string', label: 'provider', group: 'assistant', subgroup: 'model', nullable: true, choices: PROVIDERS },
  assistant_model: { type: 'string', label: 'model', group: 'assistant', subgroup: 'model', nullable: true },
  assistant_base_url: { type: 'string', label: 'endpoint', group: 'assistant', subgroup: 'model', nullable: true },
  assistant_reasoning: { type: 'string', label: 'reasoning', group: 'assistant', subgroup: 'model', nullable: true, choices: REASONINGS },
  assistant_max_steps: { type: 'number', label: 'steps per turn', group: 'assistant', subgroup: 'model', unit: 'count', min: 1, nullable: true },
  coding_context_window: { type: 'number', label: 'context window', group: 'coding', subgroup: 'compaction', unit: 'count', min: 1, nullable: true },
  coding_compact_threshold_pct: { type: 'number', label: 'auto-compact threshold %', group: 'coding', subgroup: 'compaction', unit: 'count', min: 0, max: 100 },
  coding_compact_strategy: { type: 'string', label: 'compact strategy', group: 'coding', subgroup: 'compaction', choices: ['fast'] },
  coding_compact_summarize_pct: { type: 'number', label: 'compact summarize %', group: 'coding', subgroup: 'compaction', unit: 'count', min: 1, max: 100 },
  coding_compact_max_tokens: { type: 'number', label: 'compact output cap', group: 'coding', subgroup: 'compaction', unit: 'count', min: 1, nullable: true },
  assistant_context_window: { type: 'number', label: 'context window', group: 'assistant', subgroup: 'compaction', unit: 'count', min: 1, nullable: true },
  assistant_compact_threshold_pct: { type: 'number', label: 'auto-compact threshold %', group: 'assistant', subgroup: 'compaction', unit: 'count', min: 0, max: 100 },
  assistant_compact_strategy: { type: 'string', label: 'compact strategy', group: 'assistant', subgroup: 'compaction', choices: ['fast'] },
  assistant_compact_summarize_pct: { type: 'number', label: 'compact summarize %', group: 'assistant', subgroup: 'compaction', unit: 'count', min: 1, max: 100, nullable: true },
  assistant_compact_max_tokens: { type: 'number', label: 'compact output cap', group: 'assistant', subgroup: 'compaction', unit: 'count', min: 1, nullable: true },
  supervisor_context_window: { type: 'number', label: 'context window', group: 'supervisor', subgroup: 'compaction', unit: 'count', min: 1, nullable: true },
  supervisor_compact_threshold_pct: { type: 'number', label: 'auto-compact threshold %', group: 'supervisor', subgroup: 'compaction', unit: 'count', min: 0, max: 100, nullable: true },
  supervisor_compact_strategy: { type: 'string', label: 'compact strategy', group: 'supervisor', subgroup: 'compaction', choices: ['fast'], nullable: true },
  supervisor_compact_summarize_pct: { type: 'number', label: 'compact summarize %', group: 'supervisor', subgroup: 'compaction', unit: 'count', min: 1, max: 100, nullable: true },
  supervisor_compact_max_tokens: { type: 'number', label: 'compact output cap', group: 'supervisor', subgroup: 'compaction', unit: 'count', min: 1, nullable: true },
  voice_enabled: { type: 'boolean', label: 'enabled', group: 'assistant', subgroup: 'voice' },
  sidebar_width: { type: 'number', label: 'voice pane width', group: 'assistant', subgroup: 'voice', unit: 'count', min: 10 },
  voice_spoken_voice: { type: 'string', label: 'spoken voice', group: 'assistant', subgroup: 'voice' },
  voice_stt_model: { type: 'string', label: 'hearing model', group: 'assistant', subgroup: 'voice' },
  voice_wake_word: { type: 'boolean', label: 'wake word only', group: 'assistant', subgroup: 'voice' },
  voice_wake_words: { type: 'string', label: 'wake words', group: 'assistant', subgroup: 'voice' },
  voice_wake_timeout: { type: 'number', label: 'wake timeout', group: 'assistant', subgroup: 'voice', unit: 'count', min: 1 },
  auto_plan: { type: 'boolean', label: 'auto plan', group: 'board' },
  auto_build: { type: 'boolean', label: 'auto build', group: 'board' },
  loop_budget_tokens: { type: 'number', label: 'loop token budget', group: 'board', unit: 'count', min: 1, nullable: true },
  supervisor_provider: { type: 'string', label: 'provider', group: 'supervisor', subgroup: 'model', nullable: true, choices: PROVIDERS },
  supervisor_model: { type: 'string', label: 'model', group: 'supervisor', subgroup: 'model', nullable: true },
  supervisor_base_url: { type: 'string', label: 'endpoint', group: 'supervisor', subgroup: 'model', nullable: true },
  supervisor_reasoning: { type: 'string', label: 'reasoning', group: 'supervisor', subgroup: 'model', nullable: true, choices: REASONINGS },
  supervisor_max_steps: { type: 'number', label: 'steps per turn', group: 'supervisor', subgroup: 'model', unit: 'count', min: 1, nullable: true },
  boot_last_workspace: { type: 'boolean', label: 'boot into last workspace', group: 'sessions' },
  telegram_enabled: { type: 'boolean', label: 'telegram', group: 'telegram' },
  telegram_authorized_user: { type: 'string', label: 'authorized user id', group: 'telegram', nullable: true },
  telegram_reply_mode: { type: 'string', label: 'reply mode', group: 'telegram',
    choices: ['text', 'voice', 'both'] },
  telegram_transcript_echo: { type: 'boolean', label: 'transcript echo', group: 'telegram' },
  telegram_auto_build_notifications: { type: 'boolean', label: 'auto build alerts', group: 'telegram' },
  session_digest_interval: { type: 'number', label: 'digest interval (min)', group: 'telegram' },
  update_check_interval_ms: ms('upgrade check interval', 'telegram', 0),
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
    if (m.max !== undefined && value > m.max) return `${key} must be <= ${m.max}`;
    return null;
  }
  if (m.type === 'boolean') return typeof value === 'boolean' ? null : `${key} must be true or false`;
  if (typeof value !== 'string') return `${key} must be a string`;
  if (m.pattern && !m.pattern.test(value)) return `${key} is not a valid ${m.label}: "${value}"`;
  if (m.check) return m.check(value);
  return null;
}

/** Validate a whole {key: value} patch. null is a CLEAR, not a value, so it is
 *  never validated — the caller deletes those. Returns the messages, empty when
 *  fine.
 *
 *  both write paths call this. They used not to: PATCH /settings validated and
 *  PATCH /workspaces/:id did not, so `spare_clones: -5` was refused globally
 *  and stored per workspace. A second write path is a second place to forget. */
export function validatePatch(entries: Array<[string, unknown]>): string[] {
  return entries
    .filter(([, v]) => v !== null)
    .map(([k, v]) => (isSettingKey(k) ? validateSetting(k, v) : null))
    .filter((m): m is string => m !== null);
}

/** A write that cannot be stored, with the API's error code already chosen. */
export class SettingsWriteError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export type SettingsWriteLayer = 'global' | 'workspace';

export type SettingKey = keyof typeof DEFAULTS;
export type SettingValue = (typeof DEFAULTS)[SettingKey];

export function isSettingKey(k: string): k is SettingKey {
  return Object.prototype.hasOwnProperty.call(DEFAULTS, k);
}

/** The settings a single workspace may differ on. The chain is: code
 *  default -> global row -> workspace row. THE one list: `write` refuses a
 *  workspace write of any other key, GET /settings reports `overridable`
 *  from it, and the cli's workspace screen draws its rows from that flag —
 *  there is no second list of these keys anywhere (the workspace route used
 *  to keep one, and it drifted). */
const WORKSPACE_OVERRIDABLE: readonly SettingKey[] = [
  'spare_clones', 'initial_history_depth', 'container_image', 'container_docker', 'agent_database', 'agent_soul',
  'auto_push_on_archive', 'agent_git_credentials', 'card_prefix',
  'instant_sync', 'instant_sync_push_debounce_ms', 'instant_sync_pull_interval_ms',
  'auto_plan', 'auto_build', 'loop_budget_tokens', 'telegram_auto_build_notifications',
  'cron_enabled', 'timezone',
];

/** Settings that are a fact about ONE workspace — a card prefix names one
 *  board — so a global value is meaningless. Never settable at the global
 *  layer, and GET /settings leaves them off the global list. */
const WORKSPACE_ONLY: readonly SettingKey[] = ['card_prefix', 'instant_sync'];
export const isGlobalSettable = (k: SettingKey) => !WORKSPACE_ONLY.includes(k);
export const isWorkspaceOverridable = (k: SettingKey) => WORKSPACE_OVERRIDABLE.includes(k);

/** Credentials are scoped too: a workspace may hold its own GitHub token, which
 *  is what makes the credential chain (workspace -> global -> none) the SAME
 *  chain as every other setting rather than a hand-written copy of it. */
export const isCredentialWorkspaceScoped = (k: string) => k === 'github_token';

/** Where a value came from — the layer's own name. */
export type Source = 'default' | 'global' | 'workspace';

export interface ResolveCtx { workspace?: WorkspaceRow }

/** One setting with its LAYERS exposed, not just the winner — what a client
 *  needs to render an editor (VS Code's inspect(), git's --show-origin):
 *  `default` (code), `global` (the settings row, null when unset), `workspace`
 *  (its override, null when unset or no such context), then the computed
 *  `value` + `source`. */
export interface SettingLayers {
  default: unknown;
  global: unknown;
  workspace: unknown;
  value: unknown;
  source: Source;
}

/** THE precedence rule, written once: default → global row → workspace row.
 *  Null is never stored at any layer (null in a PATCH clears), so row
 *  presence simply means "set". Everything that resolves a setting reads
 *  its answer off this. */
function computeLayers(key: SettingKey, layers: RawLayers): SettingLayers {
  let value: unknown = DEFAULTS[key];
  let source: Source = 'default';
  // Row PRESENCE decides at every level — null is never a stored value,
  // so "there is a row" and "there is an override" are the same statement.
  if (layers.global !== undefined) { value = layers.global; source = 'global'; }
  if (layers.workspace !== undefined) { value = layers.workspace; source = 'workspace'; }
  return {
    default: DEFAULTS[key],
    global: layers.global ?? null,
    workspace: layers.workspace ?? null,
    value, source,
  };
}

interface RawLayers { global?: unknown; workspace?: unknown }

/** The scopes to read for a context, in order. Every read goes through here
 *  so none can look at a different set. */
function scopesFor(ctx: ResolveCtx): string[] {
  const out = [GLOBAL];
  if (ctx.workspace) out.push(workspaceScope(ctx.workspace.id));
  return out;
}

function layersFrom(byScope: ByScope, ctx: ResolveCtx, key: string): RawLayers {
  const at = (scope: string) => byScope.get(scope)?.get(key);
  return {
    global: at(GLOBAL),
    workspace: ctx.workspace ? at(workspaceScope(ctx.workspace.id)) : undefined,
  };
}

export type SettingEntry = SettingLayers & {
  description: string; meta: SettingMeta; overridable: boolean;
};

/** scope -> key -> stored value (decrypted where it was encrypted). */
type ByScope = Map<string, Map<string, unknown>>;

/** A secret as listed — name and description, NEVER the value. */
export interface SecretMeta { name: string; description: string; scope: string }

const GENERAL = 'general';
const SECRET_NS = 'secret';

const secretMeta = (r: { key: string; scope: string; value: unknown }): SecretMeta => ({
  name: r.key, scope: r.scope,
  description: String((r.value as { description?: unknown } | null)?.description ?? ''),
});
const sortSecrets = (s: SecretMeta[]) => s.sort((a, b) =>
  (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === GLOBAL ? -1 : a.scope.localeCompare(b.scope)));

function computeLayersFor(key: SettingKey, byScope: ByScope, ctx: ResolveCtx): SettingLayers {
  const l = computeLayers(key, layersFrom(byScope, ctx, key));
  if (key !== 'coding_model' || l.value != null) return l;
  const provider = computeLayers('coding_provider', layersFrom(byScope, ctx, 'coding_provider')).value;
  const d = latestModel(typeof provider === 'string' ? provider : null);
  return { ...l, default: d, value: d };
}

// ── The object ───────────────────────────────────────────────────────────────
// ONE store for settings and secrets — a row is (scope, namespace, key).
// `namespace` separates the declared settings world ('general' — every key
// declared in code; a credential's value sits in value_enc, everything
// else's in value) from user-named secrets ('secret' — free names, token in
// value_enc, description in plain value). This is the only file that touches
// the table; every reader resolves through it, every writer writes through
// it, and a write announces its scope on the settings feed.

export class Settings {
  constructor(
    private readonly db: Db,
    private readonly encryptionKey: Buffer,
    /** The settings feed; absent in tests with no listeners. */
    private readonly events?: SettingsEvents,
  ) {}

  // ── the table, privately ───────────────────────────────────────────────────

  /** Every row at the scopes asked for, as scope -> key -> value. ONE query:
   *  resolving 30 settings must not be 30 round trips.
   *
   *  `credentials` false means PLAIN VALUES ONLY — encrypted rows are
   *  skipped, not decrypted. Resolving `spare_clones` has no business touching
   *  a credential, and decrypting every stored one on every ordinary read
   *  logged a warning per row (found by running it). `onlyKey` narrows the
   *  query to one key: a credential read decrypts that one and no other. */
  private async readStore(scopes: string[], credentials: boolean, onlyKey?: string): Promise<ByScope> {
    const out: ByScope = new Map();
    for (const s of scopes) out.set(s, new Map());
    const rows = await this.db.select().from(settings).where(and(
      inArray(settings.scope, scopes), eq(settings.namespace, GENERAL),
      ...(onlyKey ? [eq(settings.key, onlyKey)] : [])));
    for (const r of rows) {
      // A row that will not decrypt is KEPT and reported, never treated as
      // unset — unset is what a caller deletes, and one bad row must not lose
      // the rest.
      let value: unknown;
      if (r.valueEnc) {
        if (!credentials) continue;
        try { value = decrypt(this.encryptionKey, Buffer.from(r.valueEnc)); }
        catch { log.warn({ scope: r.scope, key: r.key }, 'stored credential could not be decrypted — kept, not deleted'); continue; }
      } else value = r.value;
      out.get(r.scope)?.set(r.key, value);
    }
    return out;
  }

  /** Write one value at a scope. A credential goes in the encrypted column
   *  (`write` has already made sure it is a string — what a cipher takes). */
  private async putScoped(scope: string, k: string, value: unknown): Promise<void> {
    const row = isCredential(k)
      ? { value: null, valueEnc: encrypt(this.encryptionKey, value as string) }
      : { value: value as never, valueEnc: null };
    await this.db.insert(settings)
      .values({ scope, namespace: GENERAL, key: k, ...row })
      .onConflictDoUpdate({
        target: [settings.scope, settings.namespace, settings.key],
        set: { ...row, updatedAt: new Date() },
      });
  }

  private async dropKey(k: string, scope: string): Promise<void> {
    await this.db.delete(settings).where(and(
      eq(settings.scope, scope), eq(settings.namespace, GENERAL), eq(settings.key, k)));
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async resolveWithSource<K extends SettingKey>(key: K, ctx: ResolveCtx = {}): Promise<{ value: unknown; source: Source }> {
    const byScope = await this.readStore(scopesFor(ctx), false);
    const { value, source } = computeLayersFor(key, byScope, ctx);
    return { value, source };
  }

  async resolve<K extends SettingKey>(key: K, ctx: ResolveCtx = {}): Promise<(typeof DEFAULTS)[K]> {
    return (await this.resolveWithSource(key, ctx)).value as (typeof DEFAULTS)[K];
  }

  async resolveMany<K extends SettingKey>(keys: readonly K[], ctx: ResolveCtx = {}): Promise<{ [P in K]: (typeof DEFAULTS)[P] }> {
    const byScope = await this.readStore(scopesFor(ctx), false);
    const out = {} as { [P in K]: (typeof DEFAULTS)[P] };
    for (const k of keys) out[k] = computeLayersFor(k, byScope, ctx).value as (typeof DEFAULTS)[K] as never;
    return out;
  }

  /** The builder's clock (core/clock.ts) in the `timezone` setting — the
   *  workspace's own zone when one is given, else the global one. THE door
   *  for anything that shows or reads a date. */
  async clock(ctx: ResolveCtx = {}): Promise<Clock> {
    return new Clock(await this.resolve('timezone', ctx));
  }

  /** A credential, most specific layer first — the ONE path that decrypts a
   *  declared credential. undefined = unset at every layer. */
  async credential(name: CredentialName, ctx: ResolveCtx = {}): Promise<string | undefined> {
    const byScope = await this.readStore(scopesFor(ctx), true, name);
    const l = layersFrom(byScope, ctx, name);
    const v = l.workspace ?? l.global;
    return typeof v === 'string' && v.length ? v : undefined;
  }

  /** Every credential's stored value at the global and workspace layers,
   *  decrypted — what the settings editor shows (flagged secret there). */
  async credentialLayers(ctx: ResolveCtx): Promise<Record<CredentialName, { global: string | null; workspace: string | null }>> {
    const byScope = await this.readStore(scopesFor(ctx), true);
    const out = {} as Record<CredentialName, { global: string | null; workspace: string | null }>;
    for (const name of CREDENTIAL_NAMES) {
      const l = layersFrom(byScope, ctx, name);
      out[name] = { global: typeof l.global === 'string' ? l.global : null,
        workspace: typeof l.workspace === 'string' ? l.workspace : null };
    }
    return out;
  }

  // ── the agents ──────────────────────────────────────────────────────────────────────

  /** THE door to an agent's runtime configuration — model, key, steps,
   *  compaction — for every caller in the server and, over
   *  GET /agents/:agent/config, the cli. The rules live in agentConfig.ts;
   *  this reads the rows they need (one query) and the one key each model
   *  needs (decrypting nothing else). `pin` is the session's row model
   *  (agentConfig.sessionPin); absent = the settings' model. */
  async agentConfig(agent: AgentName, o: { workspace?: WorkspaceRow; pin?: ModelPin | null } = {}): Promise<AgentConfig> {
    const ctx: ResolveCtx = o.workspace ? { workspace: o.workspace } : {};
    const [coding, own, supervisor] = await this.agentRows(['coding', agent, 'supervisor'], ctx);
    const pin = o.pin ?? null;
    const keyOf = async (provider: string) => {
      const name = credentialForProvider(provider);
      return name ? this.credential(name, ctx) : undefined;
    };
    const resolved = resolveModel(agent, coding, own, pin);
    const supervisorProvider = agent === 'supervisor' ? resolved.provider : resolveModel('supervisor', coding, supervisor, null).provider;
    return agentConfigFrom({ agent, coding, own, supervisor, pin,
      keys: { agent: await keyOf(resolved.provider), supervisor: await keyOf(supervisorProvider) },
      timezone: await this.resolve('timezone', ctx) });
  }

  /** The model trio an agent resolves to from the settings alone (no pin) —
   *  what a newborn session row is stamped with (Sessions.birthModel). */
  async agentModel(agent: AgentName, ctx: ResolveCtx = {}): Promise<{ provider: string; model: string; baseUrl: string | null }> {
    const [coding, own] = await this.agentRows(['coding', agent], ctx);
    return resolveModel(agent, coding, own, null);
  }

  /** Each agent's ten rows, typed — the ONE function that spells the three
   *  agents' setting names. One query for all of them. */
  private async agentRows(agents: readonly AgentName[], ctx: ResolveCtx): Promise<AgentRows[]> {
    const keys = agents.flatMap((a) => [
      `${a}_provider`, `${a}_model`, `${a}_base_url`, `${a}_reasoning`, `${a}_max_steps`,
      `${a}_context_window`, `${a}_compact_threshold_pct`, `${a}_compact_strategy`,
      `${a}_compact_summarize_pct`, `${a}_compact_max_tokens`,
    ] as SettingKey[]);
    const v = await this.resolveMany(keys, ctx) as Record<string, unknown>;
    const str = (k: string) => (typeof v[k] === 'string' ? v[k] as string : null);
    const num = (k: string) => (typeof v[k] === 'number' ? v[k] as number : null);
    return agents.map((a) => ({
      provider: str(`${a}_provider`), model: str(`${a}_model`), baseUrl: str(`${a}_base_url`),
      reasoning: str(`${a}_reasoning`), maxSteps: num(`${a}_max_steps`),
      contextWindow: num(`${a}_context_window`),
      compactThresholdPct: num(`${a}_compact_threshold_pct`), compactStrategy: str(`${a}_compact_strategy`),
      compactSummarizePct: num(`${a}_compact_summarize_pct`), compactMaxTokens: num(`${a}_compact_max_tokens`),
    }));
  }

  /** Is a credential set at exactly this scope (not inherited)? The
   *  workspace list's `hasCredential` flag. */
  async hasAt(name: CredentialName, scope: string): Promise<boolean> {
    const rows = await this.db.select({ key: settings.key }).from(settings).where(and(
      eq(settings.scope, scope), eq(settings.namespace, GENERAL), eq(settings.key, name)));
    return rows.length > 0;
  }

  /** Every setting with its layers for a context. */
  async layers(ctx: ResolveCtx): Promise<Record<SettingKey, SettingLayers>> {
    const byScope = await this.readStore(scopesFor(ctx), false);
    const out = {} as Record<SettingKey, SettingLayers>;
    for (const key of Object.keys(DEFAULTS) as SettingKey[]) out[key] = computeLayersFor(key, byScope, ctx);
    return out;
  }

  /** The layers plus each key's description, meta and overridability — what
   *  an editor renders from one call. */
  async block(ctx: ResolveCtx): Promise<Record<SettingKey, SettingEntry>> {
    const layers = await this.layers(ctx);
    const out = {} as Record<SettingKey, SettingEntry>;
    for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
      out[key] = { ...layers[key], description: DESCRIPTIONS[key], meta: META[key],
        overridable: isWorkspaceOverridable(key) };
    }
    return out;
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /** THE settings writer. Every route that changes a setting — global or
   *  workspace — goes through this one validation + store path, so a second
   *  door cannot accept a value the first refused. null clears; it is never
   *  stored. Announces the scope when anything was written. Returns the keys
   *  written. `by` is the writer's client id, so its own window ignores the
   *  echo. */
  async write(layer: SettingsWriteLayer, scope: string, values: Record<string, unknown>, by?: string): Promise<string[]> {
    const entries = Object.entries(values);
    const bad = entries.filter(([k]) => !isSettingKey(k) && !isCredential(k)).map(([k]) => k);
    if (bad.length) throw new SettingsWriteError('unknown_setting', `unknown settings: ${bad.join(', ')}`);
    const invalid = validatePatch(entries.filter(([k]) => !isCredential(k)));
    if (invalid.length) throw new SettingsWriteError('invalid_setting', invalid.join('; '));
    for (const [k, value] of entries) {
      if (isCredential(k) && value !== null && typeof value !== 'string') {
        throw new SettingsWriteError('invalid_args', `${k} must be a string to be stored encrypted`);
      }
      if (layer === 'global') {
        if (isSettingKey(k) && !isGlobalSettable(k)) {
          throw new SettingsWriteError('not_overridable', `${k} is a fact about one workspace — set it there`);
        }
        continue;
      }
      const okHere = isCredential(k) ? isCredentialWorkspaceScoped(k) : isWorkspaceOverridable(k as SettingKey);
      if (!okHere) throw new SettingsWriteError('not_overridable', `${k} cannot be set per workspace`);
    }
    for (const [k, value] of entries) {
      if (value === null) await this.dropKey(k, scope);
      else await this.putScoped(scope, k, value);
    }
    if (entries.length) this.events?.publish(scope, entries.map(([k]) => k), by);
    return entries.map(([k]) => k);
  }

  /** A whole scope goes — a workspace that no longer exists. Both
   *  namespaces: its overrides and its secrets. */
  async dropScope(scope: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.scope, scope));
  }

  // ── secrets — the `secret` namespace ───────────────────────────────────────
  // One row per secret: token encrypted in value_enc, description in plain
  // value. Listing reads the plain column only and never decrypts.

  /** Every secret at the scopes asked for — names and descriptions, NEVER
   *  values. Ordered global-first, then by name, so a merged list is stable. */
  async listSecrets(scopes: string[] = [GLOBAL]): Promise<SecretMeta[]> {
    const rows = await this.db.select().from(settings).where(and(
      inArray(settings.scope, scopes), eq(settings.namespace, SECRET_NS)));
    return sortSecrets(rows.map(secretMeta));
  }

  /** EVERY secret, every layer — the cli's list, which offers every workspace
   *  as a save target and so must show every workspace's rows. */
  async listAllSecrets(): Promise<SecretMeta[]> {
    const rows = await this.db.select().from(settings).where(eq(settings.namespace, SECRET_NS));
    return sortSecrets(rows.map(secretMeta));
  }

  /** One secret's value, most-specific-first over the scopes given (pass
   *  [GLOBAL, workspaceScope(id)] — workspace wins). undefined = no such
   *  secret, or it would not decrypt. */
  async readSecretValue(name: string, scopes: string[] = [GLOBAL]): Promise<string | undefined> {
    const rows = await this.db.select().from(settings).where(and(
      inArray(settings.scope, scopes), eq(settings.namespace, SECRET_NS), eq(settings.key, name)));
    const byScope = new Map(rows.map((r) => [r.scope, r]));
    for (const s of [...scopes].reverse()) {
      const r = byScope.get(s);
      if (!r) continue;
      try { return decrypt(this.encryptionKey, Buffer.from(r.valueEnc as Buffer)); }
      catch { log.warn({ scope: s, name }, 'stored secret could not be decrypted — kept, not deleted'); return undefined; }
    }
    return undefined;
  }

  /** Create or overwrite one secret at ONE scope. */
  async putSecret(scope: string, name: string, description: string, value: string): Promise<void> {
    const row = { value: { description } as never, valueEnc: encrypt(this.encryptionKey, value) };
    await this.db.insert(settings)
      .values({ scope, namespace: SECRET_NS, key: name, ...row })
      .onConflictDoUpdate({
        target: [settings.scope, settings.namespace, settings.key],
        set: { ...row, updatedAt: new Date() },
      });
  }

  /** Delete one secret at ONE scope. Returns whether a row was there. */
  async dropSecret(scope: string, name: string): Promise<boolean> {
    const gone = await this.db.delete(settings).where(and(
      eq(settings.scope, scope), eq(settings.namespace, SECRET_NS), eq(settings.key, name)))
      .returning({ key: settings.key });
    return gone.length > 0;
  }
}
