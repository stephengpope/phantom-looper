// PhantomServer's members, one line each. Stub: each is a placeholder
// type until its own file lands (one object, one file, same name).

// ── storage ────────────────────────────────────────────────────────────
/** The Postgres pool and the migration runner for both schemas. */
export type Database = object;
/** Defaults, layers (default → global → project), credentials, secrets; the settings registry. */
export type Settings = object;
/** The projects table: a registered repo, its branch rules and board facts. */
export type Projects = object;
/** The workspaces table: a checkout — files, branch, container facts. */
export type Workspaces = object;
/** The sessions table: rows, the record, holds, turn bookkeeping. */
export type Sessions = object;
/** The cards table and card revisions. */
export type Cards = object;
/** The crons table: a project's scheduled prompts and scripts. */
export type Crons = object;
/** Named snapshots of the model settings. */
export type Presets = object;
/** Detached commands a session started, their logs and status. */
export type BackgroundTasks = object;
/** Every model call's token usage, one row each. */
export type TokenLog = object;
/** The per-project Postgres database and role the agent queries. */
export type AgentDatabases = object;

// ── agents and sessions ────────────────────────────────────────────────
/** The agent-type registry: which types exist, their setting keys, which tool groups they get. */
export type AgentTypes = object;
/** A type's resolved model, key, reasoning and step limit from settings. */
export type AgentConfig = object;
/** Fills an agent's prompt layout with the server's blocks once at session create. */
export type SystemPrompt = object;
/** The models.dev snapshot: models per provider, newest, context window. */
export type ModelCatalog = object;
/** Names a session from its first messages with a model. */
export type SessionTitler = object;
/** One-liners the server holds for a session, written into the record at turn start. */
export type UserMessageQueue = object;
/** Every tool defined once; publishes a type's tools; runs one by name. */
export type Tools = object;
/** One session's live feed: turn parts, record writes, lock changes. */
export type SessionEvents = object;
/** A project's live feed of card writes. */
export type BoardEvents = object;
/** The "settings changed" feed, keys only. */
export type SettingsEvents = object;
/** A session's running bash processes so an interrupt can kill them. */
export type ForegroundCommands = object;

// ── runtime ────────────────────────────────────────────────────────────
/** The dockerode client on the socket. */
export type Docker = object;
/** Pulls and removes images; the one puller. */
export type Images = object;
/** One container per workspace: start on first call, reap when idle. */
export type WorkspaceContainers = object;
/** Warm clones ready to become a workspace. */
export type CheckoutPool = object;
/** The idle-backup sweep and the pressure sweep. */
export type Disk = object;
/** The repo's .agents/skills: list, load, create, edit. */
export type Skills = object;
/** The skills baked into the workspace image. */
export type SystemSkills = object;
/** Search and page fetch over Firecrawl into the workspace. */
export type Web = object;

// ── git ────────────────────────────────────────────────────────────────
/** Deterministic git on the volume with the system's credentials. */
export type Git = object;
/** The one flow that lands a session's work on base or brings base in. */
export type GitSync = object;
/** Per-workspace watcher that fires the sync on change. */
export type InstantSync = object;
/** The file-change child process. */
export type WorkspaceWatcher = object;
/** GitHub REST: create a repository. */
export type GitHub = object;
/** A model writes the sync's commit message from the diff. */
export type CommitMessages = object;

// ── scheduling, telegram, api ──────────────────────────────────────────
/** Croner jobs over the cron rows; fires a run as a fresh session. */
export type CronScheduler = object;
/** The Bot API client, webhook registration, the link row; hands every update to user space. */
export type TelegramBot = object;
/** Markdown → Telegram entities, file tags, the live-feed bubble. */
export type TelegramRenderer = object;
/** Inbound files: what they are, where they land. */
export type TelegramAttachments = object;
/** Speech in and out over Deepgram. */
export type TelegramVoice = object;
/** The approval gate for gated tools. */
export type TelegramApprovals = object;
/** Updates already handled; messages the bot sent, for reply mapping. */
export type TelegramDedupe = object;
/** Fastify, auth, every SDK route; the route registry door. */
export type HttpApi = object;
/** CloudBeaver: proxy, connections, enable/disable. */
export type DbConsole = object;
/** Notification channels and the send. */
export type Notifications = object;
