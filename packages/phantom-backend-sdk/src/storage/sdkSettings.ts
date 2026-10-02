// The SDK's own settings and credentials, as definitions for the registry.
// Registration order is screen order. Per-agent-type settings are made by
// `agentTypeSettings` for every registered type; user space's own come in
// through config.settings.
import { PROVIDERS, REASONINGS } from 'phantom-client-sdk';
import { TIMEZONES } from '../lib/clock.js';
import type { SettingDefinition, AgentTypeDefinition, AgentTypeSettingSuffix } from '../doors.js';

const checkTimezone = (value: string): string | null =>
  TIMEZONES.includes(value) ? null
    : `timezone must be an IANA time zone name like America/New_York or Europe/London (got "${value}")`;

type Def = SettingDefinition;
const credential = (key: string, label: string, group: string, description: string, provider?: string, extra: Partial<Def> = {}): Def =>
  ({ key, type: 'string', default: null, label, group, description, secret: true, ...(provider ? { provider } : {}), ...extra });

/** The ten settings an agent type carries, from what the type declared
 *  (doors.ts AgentTypeSetting): the SDK supplies each one's shape; the
 *  type supplies its words, default and overridability. The model and
 *  endpoint are bound to the type's provider; the FIRST registered type's
 *  model defaults to the newest in the catalog. */
export function agentTypeSettings(type: AgentTypeDefinition, options: { first: boolean }): SettingDefinition[] {
  const group = type.name;
  const providerKey = `${type.name}_provider`;
  const shape: Record<AgentTypeSettingSuffix, Omit<Def, 'key' | 'default' | 'description' | 'group'>> = {
    provider: { type: 'string', label: 'provider', subgroup: 'model', choices: PROVIDERS },
    model: { type: 'string', label: 'model', subgroup: 'model', boundToProvider: providerKey, defaultsToLatestModel: options.first },
    base_url: { type: 'string', label: 'endpoint', subgroup: 'model', boundToProvider: providerKey },
    reasoning: { type: 'string', label: 'reasoning', subgroup: 'model', choices: REASONINGS },
    max_steps: { type: 'number', label: 'steps per turn', subgroup: 'model', unit: 'count', min: 1 },
    context_window: { type: 'number', label: 'context window', subgroup: 'compaction', unit: 'count', min: 1 },
    compact_threshold_pct: { type: 'number', label: 'auto-compact threshold %', subgroup: 'compaction', unit: 'count', min: 0, max: 100 },
    compact_strategy: { type: 'string', label: 'compact strategy', subgroup: 'compaction', choices: ['fast'] },
    compact_summarize_pct: { type: 'number', label: 'compact summarize %', subgroup: 'compaction', unit: 'count', min: 1, max: 100 },
    compact_max_tokens: { type: 'number', label: 'compact output cap', subgroup: 'compaction', unit: 'count', min: 1 },
  };
  return (Object.keys(shape) as AgentTypeSettingSuffix[]).map((suffix) => {
    const declared = type.settings[suffix];
    return { key: `${type.name}_${suffix}`, group, default: declared.default ?? null, description: declared.description,
      ...(declared.projectOverridable ? { projectOverridable: true } : {}), ...shape[suffix] };
  });
}

/** The SDK's settings and credentials, in screen order. `sessionImageTag`
 *  names the session image a fresh install pulls: the backend's own release
 *  tag, or `latest` on a dev build. */
export function sdkSettings(options: { sessionImageTag: string }): SettingDefinition[] {
  return [
    { key: "voice_spoken_voice", type: "string", default: "aura-2-thalia-en", label: "spoken voice", group: "assistant",
      description: "Deepgram Aura voice the Assistant speaks with, e.g. aura-2-thalia-en, aura-2-orion-en.", subgroup: "voice" },
    { key: "voice_stt_model", type: "string", default: "nova-3", label: "hearing model", group: "assistant",
      description: "Deepgram model that hears you — the voice pane and Telegram voice notes alike. nova-3 is the current general model; nova-2 for languages it lacks.", subgroup: "voice" },
    { key: "timezone", type: "string", default: "UTC", label: "time zone", group: "general",
      description: "Your time zone — an IANA name like America/New_York or Europe/London. Every date the system shows or reads is in it: a cron's \"0 9 * * *\" is 9am here, the token report's \"today\" starts at midnight here, and the agents are told today's date here.", suggestions: TIMEZONES, check: checkTimezone, projectOverridable: true },
    { key: "card_prefix", type: "string", default: null, label: "card number prefix", group: "board",
      description: "The letters in front of every card number on this board — \"PHA\" gives PHA-7. Unset means the first three letters of the repo name.", projectOnly: true },
    { key: "cron_enabled", type: "boolean", default: true, label: "crons", group: "crons",
      description: "Scheduled prompts (crons) for this project. Off: none fire, and the agents lose their cron tools; the crons themselves are kept. A slot missed while off is not made up.", projectOverridable: true },
    { key: "spare_clones", type: "number", default: 2, label: "spare clones", group: "sessions",
      description: "Clones of the repo kept ready and waiting. A new session takes one instead of waiting for a clone. Each one costs disk.", unit: "count", min: 0, projectOverridable: true },
    { key: "maintenance_interval_ms", type: "number", default: 60000, label: "maintenance interval", group: "sessions",
      description: "How often the maintenance loop runs — restocking spare clones, backing up idle sessions, stopping idle containers, disk cleanup. Every other \"after this long\" setting is only checked this often.", unit: "ms", min: 1000 },
    { key: "spare_clone_refresh_ms", type: "number", default: 3600000, label: "spare clone refresh", group: "sessions",
      description: "A spare clone older than this is brought up to date in the background. Speed only: a session always fetches when it takes one.", unit: "ms", min: 0 },
    { key: "spare_clone_max_age_ms", type: "number", default: 604800000, label: "spare clone max age", group: "sessions",
      description: "A spare clone older than this is thrown away and cloned fresh.", unit: "ms", min: 0 },
    { key: "disk_cleanup_percent", type: "number", default: 80, label: "disk cleanup", group: "sessions",
      description: "Disk cleanup runs when the drive is over this percent full OR under 30 GB free. It shuts down sessions and deletes their files, least recently used first — even before the container idle timeout — until the disk is healthy, along with images from older releases. Each session is backed up to its branch on GitHub first, so reopening it brings its work back. Busy sessions and ones that cannot be backed up are skipped. 0 turns off the percent part; the 30 GB floor always applies.", unit: "count", min: 0, max: 100 },
    { key: "session_lock_ttl_ms", type: "number", default: 3600000, label: "session lock timeout", group: "sessions",
      description: "How long a session stays held after its holder goes quiet. A turn the server itself is running is never handed away on this clock — it is checked directly — so this only covers a client that died holding a session (a closed laptop, a killed window).", unit: "ms", min: 1000 },
    { key: "container_idle_ms", type: "number", default: 259200000, label: "container idle timeout", group: "containers",
      description: "How long a container sits unused before it is stopped. The next tool call starts a fresh one, costing a second or two. This is also when a changed image or token setting takes effect.", unit: "ms", min: 0 },
    { key: "container_memory_mb", type: "number", default: null, label: "container memory limit", group: "containers",
      description: "Unset (the default) means no cap — the container uses what the host allows. Set it only to protect a shared host; too low and builds and tests get killed part-way through.", unit: "mb", min: 128 },
    { key: "container_cpus", type: "number", default: null, label: "container cpu limit", group: "containers",
      description: "Unset (the default) means no cap. Set it only to keep one session from starving others on a shared host; fewer cores makes work slower, not impossible.", unit: "count", min: 1 },
    { key: "container_pids_limit", type: "number", default: null, label: "container process limit", group: "containers",
      description: "Unset (the default) means no cap. Set it only as fork-bomb protection on a shared host; too low and a normal parallel build hits it.", unit: "count", min: 16 },
    { key: "container_image", type: "string", default: `ghcr.io/stephengpope/phantom-backend-session:${options.sessionImageTag}`, label: "container image", group: "containers",
      description: "Must contain ripgrep. Pulled the first time a session needs it; a change applies when the container next restarts.", projectOverridable: true },
    { key: "container_docker", type: "boolean", default: true, label: "docker in the project", group: "containers",
      description: "Lets the agent run Docker inside its own container. The container gets privileged mode and a native-overlay graph-storage volume, but the daemon is NOT started for you — the agent runs `start-docker` when it wants it, so idle sessions pay nothing. Privileged is a weaker boundary: turn this off for a hardened project. Applies when the container next restarts.", projectOverridable: true },
    { key: "agent_database", type: "boolean", default: false, label: "agent database", group: "containers",
      description: "Gives the agent its own PostgreSQL database for this project — private to it, kept across sessions, reached only through its database_query tool (never by the project's code). The agent is its admin but cannot drop it. Off keeps the data; deleting the project deletes it.", projectOverridable: true },
    { key: "agent_database_shared", type: "boolean", default: false, label: "agent database shared", group: "containers",
      description: "Lets the project's code use the agent database too: the session container gets AGENT_DATABASE_URL (its connection string) and can reach the database server. Every session in the project shares the one database. Applies when the container is next created; does nothing while agent database is off.", projectOverridable: true },
    { key: "agent_soul", type: "boolean", default: false, label: "SOUL.md in the prompt", group: "coding",
      description: "Puts the repo's root SOUL.md into the coding agent's system prompt, read from the checkout when a session starts and frozen with it — so an edit reaches new sessions only. A repo without the file adds nothing.", projectOverridable: true },
    { key: "agent_agents_md", type: "boolean", default: false, label: "AGENTS.md in the prompt", group: "coding",
      description: "Puts the repo's root AGENTS.md into the coding agent's system prompt, read from the checkout when a session starts and frozen with it — so an edit reaches new sessions only. A repo without the file adds nothing. Appears after SOUL.md.", projectOverridable: true },
    { key: "initial_history_depth", type: "string", default: "7.days", label: "git history", group: "git",
      description: "How much git history a new clone gets — a span like '7.days', or 'full' for all of it. Less means a faster clone and less disk, but the agent cannot see past it. Fixed when the clone is made.", pattern: /^(full|\d+\.(second|minute|hour|day|week|month|year)s?)$/, projectOverridable: true },
    { key: "agent_git_credentials", type: "boolean", default: false, label: "agent github access", group: "git",
      description: "Puts the GitHub token inside the container so the agent can run git and gh itself — the agent can then read it. Applies when the container restarts; off does not reclaim it from a running one.", projectOverridable: true },
    { key: "instant_sync", type: "boolean", default: false, label: "instant sync", group: "git",
      description: "Keeps every running session in this project in step with the base branch on its own: a file change auto-pushes after the debounce, and base is checked with a plain git fetch on the pull interval and auto-pulled when it moved. Runs whether or not a turn is running and never fixes a conflict itself — the agent is told and resolves it. Best for a notes or second-brain repo. Takes effect at once.", projectOnly: true },
    { key: "instant_sync_push_debounce_ms", type: "number", default: 10000, label: "instant sync push debounce", group: "git",
      description: "How long the files must stay quiet after a change before instant sync pushes.", unit: "ms", min: 0, projectOverridable: true },
    { key: "instant_sync_pull_interval_ms", type: "number", default: 5000, label: "instant sync pull interval", group: "git",
      description: "How often instant sync fetches the base branch to see whether it moved. A plain git fetch — it never touches the GitHub API rate limit. Shorter means other sessions' work arrives sooner.", unit: "ms", min: 0, projectOverridable: true },
    { key: "bash_timeout_ms", type: "number", default: 120000, label: "command timeout", group: "limits",
      description: "Kills a command that set no timeout of its own; the agent can ask for a longer one per command.", unit: "ms", min: 1 },
    { key: "bash_timeout_max_ms", type: "number", default: null, label: "command timeout cap", group: "limits",
      description: "The longest timeout the agent may request for one command. Unset means no limit.", unit: "ms", min: 1 },
    { key: "max_read_bytes", type: "number", default: 262144, label: "file read limit", group: "limits",
      description: "Cap on bytes returned per file read. Bigger files are read in chunks — nothing is hidden, it just takes more calls.", unit: "bytes", min: 1 },
    { key: "max_search_results", type: "number", default: 200, label: "search result limit", group: "limits",
      description: "Cap on hits returned per search; the true total is still reported.", unit: "count", min: 1 },
    { key: "max_bash_output_bytes", type: "number", default: 1048576, label: "command output limit", group: "limits",
      description: "Cap on output kept per command; anything past it is dropped.", unit: "bytes", min: 1 },
    { key: "db_ui_enabled", type: "boolean", default: false, label: "database console", group: "database",
      description: "Serve a browser-based database console at /db on this server's address. Sign in as phantom_admin with this server's API key. The console connects as the database owner — full access to everything, this server's own tables included. Turning it off stops the console's container." },
    { key: "telegram_enabled", type: "boolean", default: false, label: "telegram", group: "telegram",
      description: "Answer Telegram DMs. Needs the telegram_bot_token key, telegram_authorized_user, and a public address (PHANTOM_BACKEND_ADDRESS) — the webhook registers itself when all three are set." },
    { key: "telegram_authorized_user", type: "string", default: null, label: "authorized user id", group: "telegram",
      description: "Your numeric Telegram user id — the ONE sender the bot answers; everyone else is silently ignored. Get it from @userinfobot." },
    { key: "session_digest_interval", type: "number", default: 5, label: "digest interval (min)", group: "telegram",
      description: "How often (minutes) to send a digest of sessions that finished their turn. 0 disables it. Sessions idle longer than this interval are included." },
    { key: "update_check_interval_ms", type: "number", default: 86400000, label: "upgrade check interval", group: "telegram",
      description: "How often the server checks GitHub for a new release and sends a Telegram notification. 0 disables the check. The check runs only when Telegram is enabled and an authorized user is set.", unit: "ms", min: 0 },
    credential("github_token", "github token", "git", "Lets phantom-looper manage GitHub repos: clone, push, and land work on the base branch. A project can hold its own token; otherwise this one is used.", undefined, { projectOverridable: true }),
    credential("anthropic_api_key", "anthropic key", "llm", "Used by every agent set to the anthropic provider.", "anthropic"),
    credential("openai_api_key", "openai key", "llm", "Used by every agent set to the openai provider.", "openai"),
    credential("google_api_key", "google key", "llm", "Used by every agent set to the google provider (Gemini).", "google"),
    credential("deepseek_api_key", "deepseek key", "llm", "Used by every agent set to the deepseek provider.", "deepseek"),
    credential("kimi_api_key", "kimi key", "llm", "Used by every agent set to the kimi provider (Moonshot AI / Kimi).", "kimi"),
    credential("xai_api_key", "xai key", "llm", "Used by every agent set to the xai provider (Grok).", "xai"),
    credential("mistral_api_key", "mistral key", "llm", "Used by every agent set to the mistral provider.", "mistral"),
    credential("groq_api_key", "groq key", "llm", "Used by every agent set to the groq provider.", "groq"),
    credential("openai_compatible_api_key", "openai-compatible key", "llm", "For OpenAI-compatible endpoints — Ollama, vLLM, OpenRouter. Not the same key as OpenAI.", "openai-compatible"),
    credential("deepgram_api_key", "deepgram key", "voice", "Speech to text and text to speech for the Assistant. Without it the Assistant has no voice."),
    credential("firecrawl_api_key", "firecrawl key", "search", "Powers the web_search and web_fetch tools; without it web calls fail. Keys at firecrawl.dev."),
    credential("telegram_bot_token", "telegram bot token", "chat", "The Telegram bot's token from @BotFather. With telegram enabled and an authorized user set (/settings), saving it registers the webhook."),
  ];
}
