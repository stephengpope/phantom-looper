// PhantomServer — the root of @phantom-agent-sdk/server. One object owns
// every service, boots them in order, runs the API, and is the only thing
// user space talks to. User space does not subclass it: it hands `create`
// a config carrying its registrations (settings, agent types, tools,
// routes, hooks) and gets a server back. Stub: signatures and the boot
// order; no bodies yet.
import type {
  Database, Settings, Projects, Workspaces, Sessions, Cards, Crons, Presets, BackgroundTasks, TokenLog, AgentDatabases,
  AgentTypes, AgentConfig, SystemPrompt, ModelCatalog, SessionTitler, UserMessageQueue, Tools,
  SessionEvents, BoardEvents, SettingsEvents, ForegroundCommands,
  Docker, Images, WorkspaceContainers, CheckoutPool, Disk, Skills, SystemSkills, Web,
  Git, GitSync, InstantSync, WorkspaceWatcher, GitHub, CommitMessages,
  CronScheduler, TelegramBot, TelegramRenderer, TelegramAttachments, TelegramVoice, TelegramApprovals, TelegramDedupe,
  HttpApi, DbConsole, Notifications,
} from './members.js';
import type { SettingDefinition, AgentTypeDefinition, ToolDefinition, RouteRegistrar } from './doors.js';

/** What user space hands `PhantomServer.create`. Everything optional:
 *  an empty config boots a server with the SDK's defaults. */
export interface PhantomServerConfig {
  /** Boot-and-connect values only (database URL, volume root, API key…).
   *  Defaults to process.env. Every behavioural knob is a setting. */
  env?: NodeJS.ProcessEnv;
  /** User space's own migrations folder and schema. The SDK's run first,
   *  in `phantom_agent_sdk`; these run after, in `schema`, with their own
   *  ledger. */
  migrations?: { dir: string; schema: string };
  /** Settings user space adds: name, default, label, group, validation.
   *  Resolved and served alongside the SDK's own. */
  settings?: SettingDefinition[];
  /** The agent types this server runs. A type names its setting keys and
   *  the tool groups it gets. The SDK ships none. */
  agentTypes: AgentTypeDefinition[];
  /** Tools user space serves from the server, alongside the SDK's. */
  tools?: ToolDefinition[];
  /** Routes user space adds to the API, under the same auth. */
  routes?: RouteRegistrar;
  /** Run after every service is up and before the API listens. User space
   *  starts its engines here (the looper, its bot) with the server in hand. */
  onStart?: (server: PhantomServer) => Promise<void>;
  /** Run first on stop, before the API closes. */
  onStop?: (server: PhantomServer) => Promise<void>;
}

export class PhantomServer {
  // ── storage ──────────────────────────────────────────────────────────
  readonly database!: Database;
  readonly settings!: Settings;
  readonly projects!: Projects;
  readonly workspaces!: Workspaces;
  readonly sessions!: Sessions;
  readonly cards!: Cards;
  readonly crons!: Crons;
  readonly presets!: Presets;
  readonly backgroundTasks!: BackgroundTasks;
  readonly tokenLog!: TokenLog;
  readonly agentDatabases!: AgentDatabases;

  // ── agents and sessions ──────────────────────────────────────────────
  readonly agentTypes!: AgentTypes;
  readonly agentConfig!: AgentConfig;
  readonly systemPrompt!: SystemPrompt;
  readonly modelCatalog!: ModelCatalog;
  readonly sessionTitler!: SessionTitler;
  readonly userMessageQueue!: UserMessageQueue;
  readonly tools!: Tools;
  readonly sessionEvents!: SessionEvents;
  readonly boardEvents!: BoardEvents;
  readonly settingsEvents!: SettingsEvents;
  readonly foregroundCommands!: ForegroundCommands;

  // ── runtime ──────────────────────────────────────────────────────────
  readonly docker!: Docker;
  readonly images!: Images;
  readonly workspaceContainers!: WorkspaceContainers;
  readonly checkoutPool!: CheckoutPool;
  readonly disk!: Disk;
  readonly skills!: Skills;
  readonly systemSkills!: SystemSkills;
  readonly web!: Web;

  // ── git ──────────────────────────────────────────────────────────────
  readonly git!: Git;
  readonly gitSync!: GitSync;
  readonly instantSync!: InstantSync;
  readonly workspaceWatcher!: WorkspaceWatcher;
  readonly github!: GitHub;
  readonly commitMessages!: CommitMessages;

  // ── scheduling, telegram, api ────────────────────────────────────────
  readonly cronScheduler!: CronScheduler;
  readonly telegramBot!: TelegramBot;
  readonly telegramRenderer!: TelegramRenderer;
  readonly telegramAttachments!: TelegramAttachments;
  readonly telegramVoice!: TelegramVoice;
  readonly telegramApprovals!: TelegramApprovals;
  readonly telegramDedupe!: TelegramDedupe;
  readonly httpApi!: HttpApi;
  readonly dbConsole!: DbConsole;
  readonly notifications!: Notifications;

  /** The server's own address and key, for a client in this process
   *  (the server's agents reach the API over loopback like any client). */
  readonly loopback!: { url: string; apiKey: string };

  private constructor(readonly config: PhantomServerConfig) {}

  /** Build every service, connected but not running. Boot order:
   *   1. env → Database (pool) → migrations: SDK schema, then user space's
   *   2. Settings (registry filled with the SDK's + config.settings)
   *   3. table owners: Projects, Workspaces, Sessions, Cards, Crons, Presets, BackgroundTasks, TokenLog, AgentDatabases
   *   4. AgentTypes (config.agentTypes) → AgentConfig, SystemPrompt, ModelCatalog, SessionTitler
   *   5. Tools (SDK's + config.tools, grouped; published per AgentTypes), UserMessageQueue, the three event feeds, ForegroundCommands
   *   6. Docker → Images → WorkspaceContainers, CheckoutPool, Disk, Skills, SystemSkills, Web
   *   7. Git → GitSync, WorkspaceWatcher → InstantSync, GitHub, CommitMessages
   *   8. CronScheduler, Telegram plumbing, Notifications, DbConsole
   *   9. HttpApi (SDK routes + config.routes), loopback
   *  Nothing listens or ticks until `start`. */
  static async create(config: PhantomServerConfig): Promise<PhantomServer> { throw stub(); }

  /** Run: `config.onStart`, then the API listens, the scheduler ticks, the
   *  maintenance loop and instant sync begin. Resolves when listening. */
  async start(): Promise<void> { throw stub(); }

  /** Stop in reverse: `config.onStop`, API closes, scheduler and loops
   *  halt, watchers end, pool drains. Resolves when everything is down. */
  async stop(): Promise<void> { throw stub(); }
}

const stub = () => new Error('PhantomServer: stub — not built yet');
