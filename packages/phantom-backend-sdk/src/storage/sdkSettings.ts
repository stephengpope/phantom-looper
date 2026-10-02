// The SDK's own settings and credentials, as definitions for the registry.
// Registration order is screen order. Per-agent-type settings are made by
// `agentTypeSettings` for every registered type; user space's own come in
// through config.settings.
import { PROVIDERS, REASONINGS } from 'phantom-client-sdk';
import { TIMEZONES } from '../lib/clock.js';
import type { SettingDefinition } from '../doors.js';

const checkTimezone = (value: string): string | null =>
  TIMEZONES.includes(value) ? null
    : `timezone must be an IANA time zone name like America/New_York or Europe/London (got "${value}")`;

type Def = SettingDefinition;
const num = (key: string, label: string, group: string, dflt: number | null, description: string, extra: Partial<Def> = {}): Def =>
  ({ key, type: 'number', default: dflt, label, group, description, ...extra });
const ms = (key: string, label: string, group: string, dflt: number, description: string, extra: Partial<Def> = {}): Def =>
  num(key, label, group, dflt, description, { unit: 'ms', min: 0, ...extra });
const bool = (key: string, label: string, group: string, dflt: boolean, description: string, extra: Partial<Def> = {}): Def =>
  ({ key, type: 'boolean', default: dflt, label, group, description, ...extra });
const str = (key: string, label: string, group: string, dflt: string | null, description: string, extra: Partial<Def> = {}): Def =>
  ({ key, type: 'string', default: dflt, label, group, description, ...extra });
const credential = (key: string, label: string, group: string, description: string, provider?: string): Def =>
  ({ key, type: 'string', default: null, label, group, description, secret: true, ...(provider ? { provider } : {}) });

/** The ten settings every agent type carries: its model (provider, model,
 *  endpoint, reasoning, steps) and its compaction. `fallbackTo` null = this is
 *  the type the others fall back to (the cascade, AgentConfig): its provider
 *  is required and its reasoning has a value; another type's are null =
 *  "the fallback type's". */
export function agentTypeSettings(type: string, options: { fallbackTo: string | null }): SettingDefinition[] {
  const group = type;
  const first = options.fallbackTo === null;
  const fallback = first ? '' : ` Empty = the ${options.fallbackTo} agent's.`;
  const providerKey = `${type}_provider`;
  return [
    str(providerKey, 'provider', group, null,
      first
        ? 'The LLM provider. Its key is set on /keys. Nothing runs until one is chosen. Per project: override on the project — set its provider first, then its model.'
        : `The AI provider this agent runs on, on its key from /keys.${fallback}`,
      { subgroup: 'model', choices: PROVIDERS, projectOverridable: true }),
    str(`${type}_model`, 'model', group, null,
      first
        ? 'Model id for the chosen provider. Empty = the newest model the catalog lists for it, so it follows releases. A project with its own provider picks its own model.'
        : `Model this agent runs with.${fallback} Required when the provider differs.`,
      { subgroup: 'model', projectOverridable: true, boundToProvider: providerKey, defaultsToLatestModel: first }),
    str(`${type}_base_url`, 'endpoint', group, null,
      `Endpoint for openai / openai-compatible. Required by openai-compatible.${first ? '' : ' Empty inherits only while the provider matches.'}`,
      { subgroup: 'model', projectOverridable: true, boundToProvider: providerKey }),
    str(`${type}_reasoning`, 'reasoning', group, first ? 'medium' : null,
      `How much the model thinks before answering. Providers map this to their own setting.${fallback}`,
      { subgroup: 'model', choices: REASONINGS, projectOverridable: true }),
    num(`${type}_max_steps`, 'steps per turn', group, null,
      'Tool calls allowed per turn before the agent must stop and answer. Empty = unlimited.',
      { subgroup: 'model', unit: 'count', min: 1, projectOverridable: true }),
    num(`${type}_context_window`, 'context window', group, null,
      `Context window size in tokens — fallback for when the model catalog doesn't know your model. Empty = use the catalog.${fallback}`,
      { subgroup: 'compaction', unit: 'count', min: 1, projectOverridable: true }),
    num(`${type}_compact_threshold_pct`, 'auto-compact threshold %', group, first ? 0 : null,
      `Percentage of the model's context window that triggers auto-compaction. 0 = off. Checked after every turn.${fallback}`,
      { subgroup: 'compaction', unit: 'count', min: 0, max: 100, projectOverridable: true }),
    str(`${type}_compact_strategy`, 'compact strategy', group, first ? 'fast' : null,
      `The compaction strategy. fast = user/assistant text only.${fallback}`,
      { subgroup: 'compaction', choices: ['fast'], projectOverridable: true }),
    num(`${type}_compact_summarize_pct`, 'compact summarize %', group, first ? 75 : null,
      `Percentage of user+assistant messages to summarize when compaction fires. The rest stay as-is.${fallback}`,
      { subgroup: 'compaction', unit: 'count', min: 1, max: 100, projectOverridable: true }),
    num(`${type}_compact_max_tokens`, 'compact output cap', group, null,
      `Output token cap for the compaction summary. Empty = the model decides.${fallback}`,
      { subgroup: 'compaction', unit: 'count', min: 1, projectOverridable: true }),
  ];
}

/** The SDK's settings. `sessionImageTag` names the session image a fresh
 *  install pulls: the backend's own release tag, or `latest` on a dev build. */
export function sdkSettings(options: { sessionImageTag: string }): SettingDefinition[] {
  return [
    // ── general ────────────────────────────────────────────────────────────
    str('timezone', 'time zone', 'general', 'UTC',
      'Your time zone — an IANA name like America/New_York or Europe/London. Every date the system shows or reads is in it: a cron\'s "0 9 * * *" is 9am here, the token report\'s "today" starts at midnight here, and the agents are told today\'s date here.',
      { check: checkTimezone, suggestions: TIMEZONES, projectOverridable: true }),
    // ── voice (the Assistant's ears and mouth, in the cli and on Telegram) ─
    str('voice_spoken_voice', 'spoken voice', 'assistant', 'aura-2-thalia-en',
      'Deepgram Aura voice the Assistant speaks with, e.g. aura-2-thalia-en, aura-2-orion-en.', { subgroup: 'voice' }),
    str('voice_stt_model', 'hearing model', 'assistant', 'nova-3',
      'Deepgram model that hears you — the voice pane and Telegram voice notes alike. nova-3 is the current general model; nova-2 for languages it lacks.', { subgroup: 'voice' }),
    // ── board ──────────────────────────────────────────────────────────────
    str('card_prefix', 'card number prefix', 'board', null,
      'The letters in front of every card number on this board — "PHA" gives PHA-7. Unset means the first three letters of the repo name.', { projectOnly: true }),
    // ── crons ──────────────────────────────────────────────────────────────
    bool('cron_enabled', 'crons', 'crons', true,
      'Scheduled prompts (crons) for this project. Off: none fire, and the agents lose their cron tools; the crons themselves are kept. A slot missed while off is not made up.', { projectOverridable: true }),
    // ── sessions ───────────────────────────────────────────────────────────
    num('spare_clones', 'spare clones', 'sessions', 2,
      'Clones of the repo kept ready and waiting. A new session takes one instead of waiting for a clone. Each one costs disk.', { unit: 'count', min: 0, projectOverridable: true }),
    ms('maintenance_interval_ms', 'maintenance interval', 'sessions', 60_000,
      'How often the maintenance loop runs — restocking spare clones, backing up idle sessions, stopping idle containers, disk cleanup. Every other "after this long" setting is only checked this often.', { min: 1000 }),
    ms('spare_clone_refresh_ms', 'spare clone refresh', 'sessions', 3_600_000,
      'A spare clone older than this is brought up to date in the background. Speed only: a session always fetches when it takes one.'),
    ms('spare_clone_max_age_ms', 'spare clone max age', 'sessions', 7 * 24 * 3_600_000,
      'A spare clone older than this is thrown away and cloned fresh.'),
    num('disk_cleanup_percent', 'disk cleanup', 'sessions', 80,
      'Disk cleanup runs when the drive is over this percent full OR under 30 GB free. It shuts down sessions and deletes their files, least recently used first — even before the container idle timeout — until the disk is healthy, along with images from older releases. Each session is backed up to its branch on GitHub first, so reopening it brings its work back. Busy sessions and ones that cannot be backed up are skipped. 0 turns off the percent part; the 30 GB floor always applies.',
      { unit: 'count', min: 0, max: 100 }),
    ms('session_lock_ttl_ms', 'session lock timeout', 'sessions', 3_600_000,
      'How long a session stays held after its holder goes quiet. A turn the backend itself is running is never handed away on this clock — it is checked directly — so this only covers a client that died holding a session (a closed laptop, a killed window).', { min: 1000 }),
    // ── containers ─────────────────────────────────────────────────────────
    ms('container_idle_ms', 'container idle timeout', 'containers', 4320 * 60_000,
      'How long a container sits unused before it is stopped. The next tool call starts a fresh one, costing a second or two. This is also when a changed image or token setting takes effect.'),
    num('container_memory_mb', 'container memory limit', 'containers', null,
      'Unset (the default) means no cap — the container uses what the host allows. Set it only to protect a shared host; too low and builds and tests get killed part-way through.', { unit: 'mb', min: 128 }),
    num('container_cpus', 'container cpu limit', 'containers', null,
      'Unset (the default) means no cap. Set it only to keep one session from starving others on a shared host; fewer cores makes work slower, not impossible.', { unit: 'count', min: 1 }),
    num('container_pids_limit', 'container process limit', 'containers', null,
      'Unset (the default) means no cap. Set it only as fork-bomb protection on a shared host; too low and a normal parallel build hits it.', { unit: 'count', min: 16 }),
    str('container_image', 'container image', 'containers', `ghcr.io/stephengpope/phantom-backend-session:${options.sessionImageTag}`,
      'Must contain ripgrep. Pulled the first time a session needs it; a change applies when the container next restarts.', { projectOverridable: true }),
    bool('container_docker', 'docker in the project', 'containers', true,
      'Lets the agent run Docker inside its own container. The container gets privileged mode and a native-overlay graph-storage volume, but the daemon is NOT started for you — the agent runs `start-docker` when it wants it, so idle sessions pay nothing. Privileged is a weaker boundary: turn this off for a hardened project. Applies when the container next restarts.', { projectOverridable: true }),
    bool('agent_database', 'agent database', 'containers', false,
      'Gives the agent its own PostgreSQL database for this project — private to it, kept across sessions, reached only through its database_query tool (never by the project\'s code). The agent is its admin but cannot drop it. Off keeps the data; deleting the project deletes it.', { projectOverridable: true }),
    bool('agent_database_shared', 'agent database shared', 'containers', false,
      'Lets the project\'s code use the agent database too: the session container gets AGENT_DATABASE_URL (its connection string) and can reach the database server. Every session in the project shares the one database. Applies when the container is next created; does nothing while agent database is off.', { projectOverridable: true }),
    // ── the prompt's repo files (grouped under the first agent type by user space's convention: here, 'prompt') ─
    bool('agent_soul', 'SOUL.md in the prompt', 'prompt', false,
      'Puts the repo\'s root SOUL.md into the agent\'s system prompt, read from the checkout when a session starts and frozen with it — so an edit reaches new sessions only. A repo without the file adds nothing.', { projectOverridable: true }),
    bool('agent_agents_md', 'AGENTS.md in the prompt', 'prompt', false,
      'Puts the repo\'s root AGENTS.md into the agent\'s system prompt, read from the checkout when a session starts and frozen with it — so an edit reaches new sessions only. A repo without the file adds nothing. Appears after SOUL.md.', { projectOverridable: true }),
    // ── git ────────────────────────────────────────────────────────────────
    str('initial_history_depth', 'git history', 'git', '7.days',
      "How much git history a new clone gets — a span like '7.days', or 'full' for all of it. Less means a faster clone and less disk, but the agent cannot see past it. Fixed when the clone is made.",
      { pattern: /^(full|\d+\.(second|minute|hour|day|week|month|year)s?)$/, projectOverridable: true }),
    bool('agent_git_credentials', 'agent github access', 'git', false,
      'Puts the GitHub token inside the container so the agent can run git and gh itself — the agent can then read it. Applies when the container restarts; off does not reclaim it from a running one.', { projectOverridable: true }),
    bool('instant_sync', 'instant sync', 'git', false,
      'Keeps every running session in this project in step with the base branch on its own: a file change auto-pushes after the debounce, and base is checked with a plain git fetch on the pull interval and auto-pulled when it moved. Runs whether or not a turn is running and never fixes a conflict itself — the agent is told and resolves it. Best for a notes or second-brain repo. Takes effect at once.', { projectOnly: true }),
    ms('instant_sync_push_debounce_ms', 'instant sync push debounce', 'git', 10_000,
      'How long the files must stay quiet after a change before instant sync pushes.', { projectOverridable: true }),
    ms('instant_sync_pull_interval_ms', 'instant sync pull interval', 'git', 5_000,
      'How often instant sync fetches the base branch to see whether it moved. A plain git fetch — it never touches the GitHub API rate limit. Shorter means other sessions\' work arrives sooner.', { projectOverridable: true }),
    // ── limits ─────────────────────────────────────────────────────────────
    num('bash_timeout_ms', 'command timeout', 'limits', 120_000,
      'Kills a command that set no timeout of its own; the agent can ask for a longer one per command.', { unit: 'ms', min: 1 }),
    num('bash_timeout_max_ms', 'command timeout cap', 'limits', null,
      'The longest timeout the agent may request for one command. Unset means no limit.', { unit: 'ms', min: 1 }),
    num('max_read_bytes', 'file read limit', 'limits', 262_144,
      'Cap on bytes returned per file read. Bigger files are read in chunks — nothing is hidden, it just takes more calls.', { unit: 'bytes', min: 1 }),
    num('max_search_results', 'search result limit', 'limits', 200,
      'Cap on hits returned per search; the true total is still reported.', { unit: 'count', min: 1 }),
    num('max_bash_output_bytes', 'command output limit', 'limits', 1_048_576,
      'Cap on output kept per command; anything past it is dropped.', { unit: 'bytes', min: 1 }),
    // ── database console ───────────────────────────────────────────────────
    bool('db_ui_enabled', 'database console', 'database', false,
      'Serve a browser-based database console at /db on this backend\'s address. Sign in as phantom_admin with this backend\'s API key. The console connects as the database owner — full access to everything, this backend\'s own tables included. Turning it off stops the console\'s container.'),
    // ── telegram — the link ────────────────────────────────────────────────
    bool('telegram_enabled', 'telegram', 'telegram', false,
      'Answer Telegram DMs. Needs the telegram_bot_token key, telegram_authorized_user, and a public address (PHANTOM_BACKEND_ADDRESS) — the webhook registers itself when all three are set.'),
    str('telegram_authorized_user', 'authorized user id', 'telegram', null,
      'Your numeric Telegram user id — the ONE sender the bot answers; everyone else is silently ignored. Get it from @userinfobot.'),
    // ── notifications ──────────────────────────────────────────────────────
    num('session_digest_interval', 'digest interval (min)', 'telegram', 5,
      'How often (minutes) to send a digest of sessions that finished their turn. 0 disables it. Sessions idle longer than this interval are included.'),
    ms('update_check_interval_ms', 'upgrade check interval', 'telegram', 86_400_000,
      'How often the backend checks GitHub for a new release and sends a Telegram notification. 0 disables the check. The check runs only when Telegram is enabled and an authorized user is set.'),

    // ── credentials ────────────────────────────────────────────────────────
    // Named the way each vendor names it: GitHub says token, everyone else
    // says API key. One key per provider, one place to set it; an agent
    // reads the key for whatever its `*_provider` setting says.
    { ...credential('github_token', 'github token', 'git',
      'Lets the backend manage GitHub repos: clone, push, and land work on the base branch. A project can hold its own token; otherwise this one is used.'), projectOverridable: true },
    credential('anthropic_api_key', 'anthropic key', 'llm', 'Used by every agent set to the anthropic provider.', 'anthropic'),
    credential('openai_api_key', 'openai key', 'llm', 'Used by every agent set to the openai provider.', 'openai'),
    credential('google_api_key', 'google key', 'llm', 'Used by every agent set to the google provider (Gemini).', 'google'),
    credential('deepseek_api_key', 'deepseek key', 'llm', 'Used by every agent set to the deepseek provider.', 'deepseek'),
    credential('kimi_api_key', 'kimi key', 'llm', 'Used by every agent set to the kimi provider (Moonshot AI / Kimi).', 'kimi'),
    credential('xai_api_key', 'xai key', 'llm', 'Used by every agent set to the xai provider (Grok).', 'xai'),
    credential('mistral_api_key', 'mistral key', 'llm', 'Used by every agent set to the mistral provider.', 'mistral'),
    credential('groq_api_key', 'groq key', 'llm', 'Used by every agent set to the groq provider.', 'groq'),
    credential('openai_compatible_api_key', 'openai-compatible key', 'llm',
      'For OpenAI-compatible endpoints — Ollama, vLLM, OpenRouter. Not the same key as OpenAI.', 'openai-compatible'),
    credential('deepgram_api_key', 'deepgram key', 'voice',
      'Speech to text and text to speech for the Assistant. Without it the Assistant has no voice.'),
    credential('firecrawl_api_key', 'firecrawl key', 'search',
      'Powers the web_search and web_fetch tools; without it web calls fail. Keys at firecrawl.dev.'),
    credential('telegram_bot_token', 'telegram bot token', 'chat',
      'The Telegram bot\'s token from @BotFather. With telegram enabled and an authorized user set (/settings), saving it registers the webhook.'),
  ];
}
