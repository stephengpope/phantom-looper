// The SDK's own settings and credentials, as definitions for the registry.
// Registration order is screen order. Per-agent-type settings are made by
// `agentTypeSettings` for every registered type; user space's own come in
// through config.settings.
import { PROVIDERS, REASONINGS } from '@phantom-agent-sdk/client';
import { TIMEZONES } from '../lib/clock.js';
import type { SettingDefinition, AgentTypeDefinition, AgentTypeSettingSuffix } from '../doors.js';
import type { OverridableLayer } from '../lib/scopes.js';
/** Whatever a project may override, an organization and a user may too — a bigger project. */
const SHARED: readonly OverridableLayer[] = ['organization', 'user', 'project'];
/** What an organization may decide for itself and a project or a user may not: where its media lives. */
const ORGANIZATION: readonly OverridableLayer[] = ['organization'];

const checkTimezone = (value: string): string | null =>
  TIMEZONES.includes(value) ? null
    : `timezone must be an IANA time zone name like America/New_York or Europe/London (got "${value}")`;

type Def = SettingDefinition;
const credential = (key: string, label: string, group: string, description: string, provider?: string, extra: Partial<Def> = {}): Def =>
  ({ key, type: 'string', default: null, label, group, description, secret: true, ...(provider ? { provider } : {}), ...extra });

/** The ten settings an agent type carries, from what the type declared
 *  (doors.ts AgentTypeSetting): the SDK supplies each one's shape; the
 *  type supplies its words, default and overridability. The model and
 *  endpoint are bound to the type's provider; a ROOT type's (one with no
 *  fallback) model defaults to the newest in the catalog. */
export function agentTypeSettings(type: AgentTypeDefinition): SettingDefinition[] {
  const group = type.name;
  const root = !type.modelFallsBackTo;
  const providerKey = `${type.name}_provider`;
  const shape: Record<AgentTypeSettingSuffix, Omit<Def, 'key' | 'default' | 'description' | 'group'>> = {
    provider: { type: 'string', label: 'provider', subgroup: 'model', choices: PROVIDERS },
    model: { type: 'string', label: 'model', subgroup: 'model', boundToProvider: providerKey, defaultsToLatestModel: root },
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
      ...(declared.overridableAt ? { overridableAt: declared.overridableAt } : {}), ...shape[suffix] };
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
      description: "Your time zone — an IANA name like America/New_York or Europe/London. Every date the system shows or reads is in it: a cron's \"0 9 * * *\" is 9am here, the token report's \"today\" starts at midnight here, and the agents are told today's date here.", suggestions: TIMEZONES, check: checkTimezone, overridableAt: SHARED },
    { key: "card_prefix", type: "string", default: null, label: "card number prefix", group: "board",
      description: "The letters in front of every card number on this board — \"PHA\" gives PHA-7. Unset means the first three letters of the repo name.", projectOnly: true },
    { key: "cron_enabled", type: "boolean", default: true, label: "crons", group: "crons",
      description: "Scheduled prompts (crons) for this project. Off: none fire, and the agents lose their cron tools; the crons themselves are kept. A slot missed while off is not made up.", overridableAt: SHARED },
    { key: "spare_clones", type: "number", default: 2, label: "spare clones", group: "sessions",
      description: "Clones of the repo kept ready and waiting. A new session takes one instead of waiting for a clone. Each one costs disk.", unit: "count", min: 0, overridableAt: SHARED },
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
    { key: "container_pids_limit", type: "number", default: 4096, label: "container process limit", group: "containers",
      description: "The most processes and threads one agent container may run at once — far above any normal build, low enough that a runaway or fork-bomb script cannot take the server down. Unset means no cap.", unit: "count", min: 16 },
    { key: "container_disk_gb", type: "number", default: null, label: "container disk limit", group: "containers",
      description: "The most disk one agent may use, in GB — its container's own files and its checkout, each held to it by the kernel: a write past it fails with \"Disk quota exceeded\", and the agent frees space and carries on. Unset (the default) means no cap. Needs Docker's storage on XFS mounted with pquota, and the disk-quota helper running; a server without both refuses the setting. The server's alone. Applies when the container next restarts.", unit: "count", min: 1 },
    { key: "container_sudo", type: "boolean", default: true, label: "sudo in the container", group: "containers",
      description: "Lets the agent become root inside its own container (passwordless sudo) — to install packages, and needed for docker in the project. Root there is still fenced by the container. Off: the kernel refuses any gain of privilege, and the agent stays an ordinary user. The server's alone. Applies when the container next restarts." },
    { key: "container_runtime", type: "string", default: null, label: "container runtime", group: "containers",
      description: "The Docker runtime agent containers run under. Unset: Docker's default. `runsc` runs them under gVisor — a kernel of their own between them and the server — for hosting other people's agents; the runtime must be installed on the server first. The server's alone. Applies when the container next restarts." },
    { key: "container_image", type: "string", default: `ghcr.io/stephengpope/phantom-backend-session:${options.sessionImageTag}`, label: "container image", group: "containers",
      description: "Must contain ripgrep. Pulled the first time a session needs it; a change applies when the container next restarts. The server's alone: what runs on it is the operator's to choose." },
    { key: "container_docker", type: "boolean", default: false, label: "docker in the project", group: "containers",
      description: "Lets the agent run Docker inside its own container. The container gets privileged mode and a native-overlay graph-storage volume, but the daemon is NOT started for you — the agent runs `start-docker` when it wants it, so idle sessions pay nothing. Privileged is a weaker boundary — a privileged container can reach the host — so it is off by default; turn it on only on a server whose agents are all yours. The server's alone, never an organization's or a project's. Applies when the container next restarts." },
    { key: "agent_database", type: "boolean", default: false, label: "agent database", group: "containers",
      description: "Gives the agent its own PostgreSQL database for this project — private to it, kept across sessions, reached only through its database_query tool (never by the project's code). The agent is its admin but cannot drop it. Off keeps the data; deleting the project deletes it.", overridableAt: SHARED },
    { key: "agent_database_shared", type: "boolean", default: false, label: "agent database shared", group: "containers",
      description: "Lets the project's code use the agent database too: the session container gets AGENT_DATABASE_URL (its connection string) and can reach the database server. Every session in the project shares the one database. Applies when the container is next created; does nothing while agent database is off.", overridableAt: SHARED },
    { key: "agent_soul", type: "boolean", default: false, label: "SOUL.md in the prompt", group: "coding",
      description: "Puts the repo's root SOUL.md into the coding agent's system prompt, read from the checkout when a session starts and frozen with it — so an edit reaches new sessions only. A repo without the file adds nothing.", overridableAt: SHARED },
    { key: "agent_agents_md", type: "boolean", default: false, label: "AGENTS.md in the prompt", group: "coding",
      description: "Puts the repo's root AGENTS.md into the coding agent's system prompt, read from the checkout when a session starts and frozen with it — so an edit reaches new sessions only. A repo without the file adds nothing. Appears after SOUL.md.", overridableAt: SHARED },
    { key: "auto_push_on_archive", type: "boolean", default: true, label: "auto-push on archive", group: "git",
      description: "Archiving a done card auto-pushes its session's work to the base branch; a failed push un-archives the card into blocked. Archiving from any other column never pushes.", overridableAt: SHARED },
    { key: "agent_git_credentials", type: "boolean", default: false, label: "agent github access", group: "git",
      description: "Puts the GitHub token inside the container so the agent can run git and gh itself — the agent can then read it. Applies when the container restarts; off does not reclaim it from a running one.", overridableAt: SHARED },
    { key: "instant_sync", type: "boolean", default: false, label: "instant sync", group: "git",
      description: "Keeps every running session in this project in step with the base branch on its own: a file change auto-pushes after the debounce, and base is checked with a plain git fetch on the pull interval and auto-pulled when it moved. Runs whether or not a turn is running and never fixes a conflict itself — the agent is told and resolves it. Best for a notes or second-brain repo. Takes effect at once.", projectOnly: true },
    { key: "instant_sync_push_debounce_ms", type: "number", default: 10000, label: "instant sync push debounce", group: "git",
      description: "How long the files must stay quiet after a change before instant sync pushes.", unit: "ms", min: 0, overridableAt: SHARED },
    { key: "instant_sync_pull_interval_ms", type: "number", default: 5000, label: "instant sync pull interval", group: "git",
      description: "How often instant sync fetches the base branch to see whether it moved. A plain git fetch — it never touches the GitHub API rate limit. Shorter means other sessions' work arrives sooner.", unit: "ms", min: 0, overridableAt: SHARED },
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
    { key: "api_docs_enabled", type: "boolean", default: false, label: "API docs", group: "console",
      description: "The API's own documentation at /docs — every route, its parameters and answers, generated from the code, and tried from the page. Behind the same login as the database console: user console_admin, password this server's API key. Off: nothing is there." },
    { key: "db_ui_enabled", type: "boolean", default: false, label: "database console", group: "database",
      description: "Serve a browser-based database console at /db on this server's address. Sign in as console_admin with this server's API key. The console connects as the database superuser — full access to everything, this server's own tables included. Turning it off stops the console's container." },
    { key: "telegram_enabled", type: "boolean", default: false, label: "telegram", group: "telegram",
      description: "Answer Telegram DMs. Needs the telegram_bot_token key, telegram_authorized_user, and a public address (PHANTOM_BACKEND_ADDRESS) — the webhook registers itself when all three are set." },
    { key: "telegram_authorized_user", type: "string", default: null, label: "authorized user id", group: "telegram",
      description: "Your numeric Telegram user id — the operator's own chat with the bot, which sees the whole server. Every other user links their own chat (POST /api/telegram/links) and sees only their own work; a chat nobody linked is ignored. Get it from @userinfobot." },
    { key: "session_digest_interval", type: "number", default: 5, label: "digest interval (min)", group: "telegram",
      description: "How often (minutes) to send a digest of sessions that finished their turn. 0 disables it. Sessions idle longer than this interval are included." },
    { key: "update_check_interval_ms", type: "number", default: 86400000, label: "upgrade check interval", group: "telegram",
      description: "How often the server checks GitHub for a new release and sends a Telegram notification. 0 disables the check. The check runs only when Telegram is enabled and an authorized user is set.", unit: "ms", min: 0 },
    { key: "smtp_host", type: "string", default: null, label: "smtp host", group: "mail",
      description: "The SMTP server mail goes out through — any provider with an SMTP door (smtp.gmail.com, smtp.fastmail.com, email-smtp.<region>.amazonaws.com). Mail is off until host, port, user, password and from are all set." },
    { key: "smtp_port", type: "number", default: 587, label: "smtp port", group: "mail",
      description: "587 is STARTTLS (the usual); 465 is TLS from the first byte — set smtp secure with it.", unit: "count", min: 1, max: 65535 },
    { key: "smtp_secure", type: "boolean", default: false, label: "smtp secure", group: "mail",
      description: "On: TLS from the first byte (port 465). Off: plain connection upgraded with STARTTLS (port 587)." },
    { key: "smtp_user", type: "string", default: null, label: "smtp user", group: "mail",
      description: "The login at the SMTP server — usually the full address." },
    { key: "smtp_from", type: "string", default: null, label: "from address", group: "mail",
      description: "What mail from this server is sent as: an address, or \"Name <address>\". Most providers insist it is one the login owns." },
    { key: "agent_media", type: "boolean", default: false, label: "agent media", group: "media", overridableAt: SHARED,
      description: "Gives the agents the media tools (list, link, download, upload) and tells them in their system prompt. Takes effect only where media storage is configured. Off by default: turning it on is a choice per server, organization, user or project, and off does not need the storage settings cleared." },
    { key: "media_endpoint", type: "string", default: null, label: "storage endpoint", group: "media", overridableAt: ORGANIZATION,
      description: "The S3-compatible storage media files go to: the provider's S3 API address (https://<account>.r2.cloudflarestorage.com, https://s3.us-east-1.amazonaws.com, https://s3.us-west-004.backblazeb2.com). Media is off until endpoint, bucket and both keys are set. An organization that sets all four at its own layer stores its files in its own bucket." },
    { key: "media_region", type: "string", default: "auto", label: "storage region", group: "media", overridableAt: ORGANIZATION,
      description: "The bucket's region as the provider names it (us-east-1, eu-central-1). R2 takes auto." },
    { key: "media_bucket", type: "string", default: null, label: "storage bucket", group: "media", overridableAt: ORGANIZATION,
      description: "The bucket media files are kept in. Keep it private: files are reached through short-lived links." },
    { key: "media_max_bytes", type: "number", default: 5 * 1024 ** 3, label: "max file size", group: "media", overridableAt: ORGANIZATION,
      description: "The largest media file accepted. Checked before an upload starts and against what actually arrived.", unit: "bytes", min: 1 },
    { key: "media_allowed_types", type: "string", default: "image/*, video/*, audio/*, application/pdf", label: "allowed file types", group: "media", overridableAt: ORGANIZATION,
      description: "The file types media accepts, comma-separated: exact (application/pdf) or a whole family (image/*). The type is read from the file's own bytes, not taken from the uploader." },
    { key: "media_link_seconds", type: "number", default: 900, label: "link lifetime", group: "media", overridableAt: ORGANIZATION,
      description: "How long a download link works when the caller does not ask for a length, in seconds.", unit: "count", min: 60, max: 604800 },
    { key: "media_link_max_seconds", type: "number", default: 3600, label: "longest link", group: "media", overridableAt: ORGANIZATION,
      description: "The longest a caller may ask a link to work, in seconds. Providers allow at most 604800 (7 days).", unit: "count", min: 60, max: 604800 },
    credential("github_token", "github token", "git", "Lets phantom-looper manage GitHub repos: clone, push, and land work on the base branch. A project can hold its own token; otherwise this one is used.", undefined, { overridableAt: SHARED }),
    credential("anthropic_api_key", "anthropic key", "llm", "Used by every agent set to the anthropic provider.", "anthropic", { overridableAt: SHARED }),
    credential("openai_api_key", "openai key", "llm", "Used by every agent set to the openai provider.", "openai", { overridableAt: SHARED }),
    credential("google_api_key", "google key", "llm", "Used by every agent set to the google provider (Gemini).", "google", { overridableAt: SHARED }),
    credential("deepseek_api_key", "deepseek key", "llm", "Used by every agent set to the deepseek provider.", "deepseek", { overridableAt: SHARED }),
    credential("kimi_api_key", "kimi key", "llm", "Used by every agent set to the kimi provider (Moonshot AI / Kimi).", "kimi", { overridableAt: SHARED }),
    credential("xai_api_key", "xai key", "llm", "Used by every agent set to the xai provider (Grok).", "xai", { overridableAt: SHARED }),
    credential("mistral_api_key", "mistral key", "llm", "Used by every agent set to the mistral provider.", "mistral", { overridableAt: SHARED }),
    credential("groq_api_key", "groq key", "llm", "Used by every agent set to the groq provider.", "groq", { overridableAt: SHARED }),
    credential("openai_compatible_api_key", "openai-compatible key", "llm", "For OpenAI-compatible endpoints — Ollama, vLLM, OpenRouter. Not the same key as OpenAI.", "openai-compatible", { overridableAt: SHARED }),
    credential("deepgram_api_key", "deepgram key", "voice", "Speech to text and text to speech for the Assistant. Without it the Assistant has no voice.", undefined, { overridableAt: SHARED }),
    credential("firecrawl_api_key", "firecrawl key", "search", "Powers the web_search and web_fetch tools; without it web calls fail. Keys at firecrawl.dev.", undefined, { overridableAt: SHARED }),
    credential("smtp_password", "smtp password", "mail", "The SMTP login's password or app password. With the other smtp settings set, POST /api/mail/test proves it."),
    credential("media_access_key_id", "storage access key", "media", "The access key id of a key the storage provider issued for the media bucket.", undefined, { overridableAt: ORGANIZATION }),
    credential("media_secret_access_key", "storage secret key", "media", "The secret that goes with the storage access key.", undefined, { overridableAt: ORGANIZATION }),
    credential("telegram_bot_token", "telegram bot token", "chat", "The Telegram bot's token from @BotFather. With telegram enabled and an authorized user set (/settings), saving it registers the webhook."),
  ];
}
