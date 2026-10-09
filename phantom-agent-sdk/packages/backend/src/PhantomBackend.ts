// PhantomBackend — the root of @phantom-agent-sdk/backend. One object owns
// every service, boots them in order, runs the API, and is the only thing
// user space talks to. User space does not subclass it: it hands `create`
// a config carrying its registrations (settings, agent types, tools,
// routes, hooks) and gets a backend back.
//
// `create` builds everything, connected but not running; `start` builds the
// routes, runs `config.onStart`, begins the loops and listens; `stop` winds
// down in reverse. There is no other way in: the API, the loops and the
// registries are the backend's own, reached through the config and nothing
// else. The members are the objects every route, tool and engine reads.
import { readEnv, APP_VERSION, type Env } from './lib/env.js';
import { logger, errStr } from './lib/log.js';
import { makePaths, type Paths } from './lib/paths.js';
import { Database, SDK_MIGRATIONS } from './storage/Database.js';
import { Settings } from './storage/Settings.js';
import { sdkSettings, agentTypeSettings } from './storage/sdkSettings.js';
import { envName, settingsFromEnv } from './storage/envSettings.js';
import { Projects } from './storage/Projects.js';
import { Workspaces } from './storage/Workspaces.js';
import { Sessions } from './storage/Sessions.js';
import { Cards } from './storage/Cards.js';
import { Crons } from './storage/Crons.js';
import { Presets } from './storage/Presets.js';
import { BackgroundTasks } from './storage/BackgroundTasks.js';
import { TokenLog } from './storage/TokenLog.js';
import { AgentDatabases } from './storage/AgentDatabases.js';
import { AgentTypes } from './agents/AgentTypes.js';
import { AgentConfig } from './agents/AgentConfig.js';
import { ModelCatalog } from './agents/ModelCatalog.js';
import { SessionNotes } from './agents/SessionNotes.js';
import { SessionEvents } from './agents/SessionEvents.js';
import { BoardEvents } from './agents/BoardEvents.js';
import { SettingsEvents } from './agents/SettingsEvents.js';
import { ForegroundCommands } from './agents/ForegroundCommands.js';
import { makeDocker } from './runtime/Docker.js';
import { LocalHost } from './runtime/LocalHost.js';
import { SessionRunners } from './host/SessionRunners.js';
import { Images } from './runtime/Images.js';
import { SessionContainers } from './runtime/SessionContainers.js';
import * as checkoutPool from './runtime/CheckoutPool.js';
import { GitService, type GitHooks } from './git/GitService.js';
import { idleBackupSweep, pressureSweep } from './runtime/Disk.js';
import { refreshWorkState } from './git/workRefresh.js';
import { TelegramBotState } from './telegram/botState.js';
import { TelegramSentMessages } from './telegram/sentMessages.js';
import { TelegramChats } from './telegram/chats.js';
import { TelegramHandledUpdates } from './telegram/handledUpdates.js';
import { TelegramBot, type TelegramCommand } from './telegram/TelegramBot.js';
import type { SettingDefinition, AgentTypeDefinition, ToolDefinition, RouteRegistrar, CardFieldsExtension } from './doors.js';
import { Notifications } from './Notifications.js';
import { Mailer } from './mail/Mailer.js';
import { Media } from './media/Media.js';
import { CronScheduler, CRON_STARTER, type CronAgent } from './crons/CronScheduler.js';
import { Identity, type IdentityOptions } from './identity/Identity.js';
import { SessionTitler, type TitleWriter } from './agents/SessionTitler.js';
import { HttpApi } from './api/HttpApi.js';
import { registerTools } from './tools/registry.js';
import { reconcileDbUi } from './api/routes/dbUi.js';
import type Docker from 'dockerode';

const log = logger('backend');

/** What user space hands `PhantomBackend.create`. Everything optional but
 *  the agent types: an empty config boots a backend with the SDK's defaults
 *  and no agent to run. */
export interface PhantomBackendConfig {
  /** Boot-and-connect values only (database URL, volume root, API key…).
   *  Defaults to process.env. Every behavioural knob is a setting. */
  env?: NodeJS.ProcessEnv;
  /** User space's own migrations folder and the schema whose ledger records
   *  them. The SDK's run first. */
  migrations?: { dir: string; ledgerSchema: string };
  /** Settings user space adds: resolved and served alongside the SDK's own. */
  settings?: SettingDefinition[];
  /** Crons: give the agent a prompt cron runs (an Agent subclass, e.g. the
   *  app's coding agent) and the SDK schedules and runs every project's
   *  crons, each as its owner. Absent: the cron rows and tools exist, and
   *  nothing fires. */
  crons?: { agent: CronAgent };
  /** Values the app fixes, by key (the SDK's settings or its own): each wins
   *  over every layer for every caller, and any write to it is refused with
   *  403 access denied. */
  fixedSettings?: Record<string, unknown>;
  /** The settings a deployment may fix from its environment, by key: each
   *  read from its name in capitals (smtp_host from SMTP_HOST) and, when set,
   *  fixed exactly as above (storage/envSettings.ts). */
  envSettings?: readonly string[];
  /** The agent types this backend runs. The SDK ships none. */
  agentTypes: AgentTypeDefinition[];
  /** The app's automations that open sessions for themselves (`started_by`
   *  values): a default list leaves their sessions out. A person's session
   *  is `started_by: person`, the SDK's one word; every other opener says
   *  its own name on POST /sessions. */
  backgroundStarters?: string[];
  /** Tools user space serves from the backend, alongside the SDK's. */
  tools?: ToolDefinition[];
  /** Fields the app keeps about a card in its own table, carried on every
   *  card the SDK answers and taken by every card write (Cards). */
  cardFields?: CardFieldsExtension;
  /** Routes user space adds, under /app — no key check: the app gates each
   *  with backend.identity.require. */
  routes?: RouteRegistrar;
  /** Turns sign-in on: people, organizations, invitations, API keys
   *  (Identity). Absent = off: no route, nothing written. */
  identity?: IdentityOptions;
  /** What the app brings to the backend's git: its conflict fixer, its
   *  commit-message writer, its words after a sync (GitService). */
  git?: GitHooks;
  /** Extra facts GET /health reports beside `ok` and `version` — what the
   *  app's engines have in flight. */
  health?: () => Record<string, unknown>;
  /** Run after every service is up and before the API listens. User space
   *  starts its engines here (the looper, its bot) with the backend in hand. */
  onStart?: (backend: PhantomBackend) => Promise<void>;
  /** Run first on stop, before the API closes. */
  onStop?: (backend: PhantomBackend) => Promise<void>;
  /** Write a session's title from the selected user messages — a model
   *  call, the app's until the backend makes it on the client SDK's billed
   *  model (docs/v1-plan.md). The cadence, the selection and
   *  the write-back are the SDK's (SessionTitler). */
  writeTitle?: TitleWriter;
  /** The Telegram command menu the bot registers: the global default and
   *  the authorized chat's. The commands are the app's, and so is whatever
   *  the chat's menu depends on (the app's own bot state). */
  telegramCommandMenu?: () => Promise<{ global: TelegramCommand[]; forChat?: TelegramCommand[] }>;
}

export class PhantomBackend {
  readonly env: Env;
  /** This backend's release (`vX.Y.Z`), or 'dev' for a checkout. */
  readonly version = APP_VERSION;
  readonly paths: Paths;

  // ── storage ──────────────────────────────────────────────────────────
  readonly database: Database;
  readonly settings: Settings;
  readonly projects: Projects;
  readonly workspaces: Workspaces;
  readonly sessions: Sessions;
  readonly cards: Cards;
  readonly crons: Crons;
  readonly presets: Presets;
  readonly backgroundTasks: BackgroundTasks;
  readonly tokenLog: TokenLog;
  readonly agentDatabases: AgentDatabases;

  // ── agents and sessions ──────────────────────────────────────────────
  readonly agentTypes: AgentTypes;
  readonly agentConfig: AgentConfig;
  readonly modelCatalog: ModelCatalog;
  readonly sessionNotes: SessionNotes;
  readonly sessionEvents: SessionEvents;
  readonly boardEvents: BoardEvents;
  readonly settingsEvents: SettingsEvents;
  readonly foregroundCommands: ForegroundCommands;
  readonly notifications = new Notifications();
  /** Outbound mail (SMTP, the smtp_* settings). */
  readonly mailer: Mailer;
  /** Tracked files on S3-compatible storage (the media_* settings). */
  readonly media: Media;
  /** Who a caller is: the service role key, or a signed-in user (config.identity). */
  readonly identity: Identity;
  readonly sessionTitler: SessionTitler;
  /** The backend's git: manual ops, auto-push/pull, instant sync, the archive policy. */
  readonly git: GitService;
  readonly #httpApi: HttpApi;
  /** Where a client in this process reaches the API: plain HTTP on
   *  loopback. The backend's own agents are clients like any other. */
  get loopback(): { url: string; serviceRoleKey: string } {
    return { url: `http://127.0.0.1:${this.env.port}/api`, serviceRoleKey: this.env.serviceRoleKey };
  }

  // ── runtime ──────────────────────────────────────────────────────────
  readonly docker: Docker;
  readonly images: Images;
  readonly sessionContainers: SessionContainers;
  /** The hosts workspaces run on: the backend's own (this process) and every
   *  session runner that registered — and where each workspace is. */
  readonly sessionRunners: SessionRunners;

  // ── telegram tables ──────────────────────────────────────────────────
  readonly telegramBotState: TelegramBotState;
  readonly telegramSentMessages: TelegramSentMessages;
  readonly telegramHandledUpdates: TelegramHandledUpdates;
  readonly telegramBot: TelegramBot;
  /** Which Telegram chat is whose (telegram/chats.ts). */
  readonly telegramChats: TelegramChats;

  #stopped = false;
  #cronScheduler: CronScheduler | undefined;
  #loops: Promise<void>[] = [];

  private constructor(readonly config: PhantomBackendConfig, built: Built) {
    this.env = built.env; this.paths = built.paths; this.database = built.database; this.settings = built.settings;
    this.projects = built.projects; this.workspaces = built.workspaces; this.sessions = built.sessions; this.cards = built.cards;
    this.crons = built.crons; this.presets = built.presets; this.backgroundTasks = built.backgroundTasks; this.tokenLog = built.tokenLog;
    this.agentDatabases = built.agentDatabases; this.agentTypes = built.agentTypes; this.agentConfig = built.agentConfig;
    this.modelCatalog = built.modelCatalog; this.sessionNotes = built.sessionNotes; this.sessionEvents = built.sessionEvents;
    this.boardEvents = built.boardEvents; this.settingsEvents = built.settingsEvents; this.foregroundCommands = built.foregroundCommands;
    this.docker = built.docker; this.images = built.images; this.sessionContainers = built.sessionContainers;
    this.sessionRunners = built.sessionRunners; this.telegramBotState = built.telegramBotState;
    this.telegramSentMessages = built.telegramSentMessages; this.telegramHandledUpdates = built.telegramHandledUpdates;
    this.sessionTitler = new SessionTitler(this.sessions, config.writeTitle);
    this.mailer = new Mailer(this.settings);
    this.media = built.media;
    this.identity = new Identity(this.database, this.mailer, this.settings, this.projects, this.media, config.identity, this.env.publicUrl, this.env.serviceRoleKey);
    this.telegramChats = new TelegramChats(this.database.drizzle, this.database.system);
    this.telegramBot = new TelegramBot({ settings: this.settings, settingsEvents: this.settingsEvents, botState: this.telegramBotState,
      chats: this.telegramChats, sessions: this.sessions, projects: this.projects,
      sentMessages: this.telegramSentMessages, handledUpdates: this.telegramHandledUpdates, hosts: this.sessionRunners,
      publicAddress: process.env.TELEGRAM_WEBHOOK_ADDRESS || process.env.BACKEND_ADDRESS, commandMenu: config.telegramCommandMenu });
    this.git = new GitService({
      sessions: this.sessions, workspaces: this.workspaces, cards: this.cards, projects: this.projects, settings: this.settings, hosts: this.sessionRunners,
      sessionEvents: this.sessionEvents, boardEvents: this.boardEvents, settingsEvents: this.settingsEvents,
      sessionNotes: this.sessionNotes, sessionContainers: this.sessionContainers,
    }, config.git ?? {});
    this.#httpApi = new HttpApi(this, this.env.serviceRoleKey, config.routes);
  }

  /** What GET /health says beyond `ok` and `version`. */
  healthExtras(): Record<string, unknown> { return this.config.health?.() ?? {}; }

  /** Build every service, connected but not running. Boot order:
   *   1. env → Database (the roles, as the superuser; the pool, as backend) → migrations as migrator: the SDK's, then user space's
   *   2. the three event feeds; ModelCatalog; AgentTypes (config.agentTypes)
   *   3. Settings — registered in screen order: each type's ten, the SDK's, user space's
   *   4. AgentConfig, AgentDatabases, Projects, Workspaces, Cards
   *   5. Docker, Images, Sessions (following the model settings), the rest of the table owners
   *   6. the Telegram tables, the queue, foreground commands, SessionContainers, the watcher
   *   7. the git service (instant sync follows the containers), the API
   *  Nothing listens or ticks until `start`. */
  static async create(config: PhantomBackendConfig, options: { sessionImageTag?: string } = {}): Promise<PhantomBackend> {
    const env = readEnv(config.env ?? process.env);
    const database = await Database.open(env.databaseUrl, env.encryptionKey);
    await database.migrate(SDK_MIGRATIONS);
    if (config.migrations) await database.migrate(config.migrations);
    const paths = makePaths(env.workspaceRoot);
    await checkoutPool.bootCleanup(paths);

    const boardEvents = new BoardEvents();
    const sessionEvents = new SessionEvents();
    const settingsEvents = new SettingsEvents();
    const modelCatalog = new ModelCatalog();
    void modelCatalog.refresh();
    const agentTypes = new AgentTypes();
    agentTypes.register(config.agentTypes);
    registerTools(config.tools ?? []);

    const settings = new Settings(database.drizzle, env.encryptionKey, modelCatalog, settingsEvents, database.system);
    for (const type of agentTypes.list()) settings.register(agentTypeSettings(type));
    settings.register(sdkSettings({ sessionImageTag: options.sessionImageTag ?? (/^v\d+\.\d+\.\d+/.test(APP_VERSION) ? APP_VERSION : 'latest') }));
    settings.register(config.settings ?? []);
    // Fixed by the app (its constructor) and by the deployment (the listed
    // settings, from the environment) — the same thing, so one value may not be both.
    const fromEnv = settingsFromEnv(settings, config.envSettings ?? [], config.env ?? process.env);
    for (const [key, value] of Object.entries(config.fixedSettings ?? {})) {
      if (key in fromEnv && fromEnv[key] !== value) {
        throw new Error(`${key} is fixed twice: ${JSON.stringify(value)} by the app, ${JSON.stringify(fromEnv[key])} by ${envName(key)}`);
      }
    }
    settings.fix({ ...config.fixedSettings, ...fromEnv });
    const agentConfig = new AgentConfig(settings, agentTypes, modelCatalog);

    const agentDatabases = new AgentDatabases(database.pool, database.url, env.encryptionKey);
    const projects = new Projects(database.drizzle, settings, settingsEvents, agentDatabases);
    const docker = makeDocker();
    // THE image puller/remover — every pull and removal in this process goes through it so they never overlap.
    const images = new Images(docker);
    // The backend's own runner: this process's volume and Docker. Every workspace
    // call goes through a host (runtime/WorkspaceHost.ts); a workspace placed
    // nowhere else is here. RUN_SESSION_CONTAINERS=0: this server runs no
    // session containers itself — every workspace lands on a session runner (a
    // cloud API with its database, and nothing else, on the box).
    const localHost = new LocalHost(docker, images, paths, {
      volume: process.env.WORKSPACE_VOLUME, network: process.env.AGENT_NETWORK, databaseContainer: process.env.AGENT_DATABASE_CONTAINER,
      diskQuota: process.env.DISK_QUOTA_URL || undefined, apiImage: process.env.API_IMAGE,
    });
    const sessionRunners = new SessionRunners(database.system, localHost, { runsContainers: !/^(0|off|false|no)$/i.test(process.env.RUN_SESSION_CONTAINERS ?? '1'), settings });
    await sessionRunners.load();
    const workspaces = new Workspaces(database.drizzle, sessionRunners, settings, sessionEvents);
    const cards = new Cards(database.drizzle, projects, boardEvents, config.cardFields);
    const media = new Media(database.drizzle, settings);
    const sessions = new Sessions(database.drizzle, settings, agentConfig, agentTypes, projects, workspaces,
      { backgroundStarters: [...(config.backgroundStarters ?? []), ...(config.crons ? [CRON_STARTER] : [])], events: sessionEvents, prompt: { hosts: sessionRunners, docker, media } });
    // A settings write reaches every session nothing has been said to yet: its row takes the settings' model.
    settingsEvents.subscribe(() => {
      sessions.followModelSettings().catch((error) => log.warn({ err: errStr(error) }, 'newborn sessions could not follow the model settings'));
    });
    const backgroundTasks = new BackgroundTasks(database.drizzle);
    const presets = new Presets(database.drizzle, settings);
    const crons = new Crons(database.drizzle, settings);
    const tokenLog = new TokenLog(database.drizzle);
    // The bot's own bookkeeping is the server's, whoever it is working for.
    const telegramBotState = new TelegramBotState(database.system, env.encryptionKey);
    // One-time: blobs written before they were bound to their row (lib/crypto.ts).
    await settings.bindRows();
    await telegramBotState.bindRows();
    const telegramSentMessages = new TelegramSentMessages(database.system);
    const telegramHandledUpdates = new TelegramHandledUpdates(database.system);
    const sessionNotes = new SessionNotes();
    const foregroundCommands = new ForegroundCommands();
    // Instant sync follows the containers: a container up is a workspace to
    // watch, a container gone is one to drop. The hooks are closures over the
    // backend, which exists long before any container starts.
    const sessionContainers = new SessionContainers(sessionRunners, {
      settings, databases: agentDatabases,
      onStarted: (workspaceId, project) => backend.git.instantSync.watchWorkspace(workspaceId, project),
      onRemoved: (workspaceId) => backend.git.instantSync.unwatchWorkspace(workspaceId),
    });

    // A disk limit is only accepted where this server can enforce it.
    settings.requireSupport('container_disk_gb', () => sessionContainers.diskSupport());

    const backend: PhantomBackend = new PhantomBackend(config, {
      media, env, paths, database, settings, projects, workspaces, sessions, cards, crons, presets, backgroundTasks, tokenLog, agentDatabases,
      agentTypes, agentConfig, modelCatalog, sessionNotes, sessionEvents, boardEvents, settingsEvents, foregroundCommands,
      docker, images, sessionContainers, sessionRunners, telegramBotState, telegramSentMessages, telegramHandledUpdates,
    });
    return backend;
  }

  /** THE busy rule, for the idle timeout and disk cleanup alike: a
   *  workspace is busy while a session on it holds a live lock — a turn is
   *  running. Nothing else counts. A background task does NOT: a dev server
   *  left running never exits, and it kept its session's container and
   *  files past every timeout, for ever. Only a person's turn is activity. */
  async busyWorkspaces(ids: string[]): Promise<Set<string>> {
    return this.sessions.workspacesHeld(ids);
  }

  /** Workspaces with a running container not touched for `idleMs` and not busy — what the idle reaper takes. */
  async idleContainerWorkspaces(idleMs: number): Promise<string[]> {
    const active = await this.sessionContainers.activeWorkspaces();
    const idle = await this.workspaces.listIdle(active, idleMs);
    const busy = await this.busyWorkspaces(idle);
    return idle.filter((id) => !busy.has(id));
  }

  /** Begin the backend's own loops: the maintenance loop (pool stock, the
   *  idle backup sweep, idle reaping, the disk-pressure sweep) and the
   *  work-state refresh. */
  #startLoops(): void {
    this.#loops.push(this.#loop(async () => {
      if (this.sessionRunners.runsContainers) await checkoutPool.tick(this.projects, this.settings, this.paths).catch((error) => log.error({ err: errStr(error) }, 'pool tick threw'));
      await idleBackupSweep(this.projects, this.sessions, this.git.sync).catch((error) => log.error({ err: errStr(error) }, 'idle backup sweep threw'));
      const idleMs = await this.settings.resolve<number>('container_idle_ms').catch(() => 30 * 60_000);
      await this.sessionContainers.reap(Number(idleMs), (idleMs) => this.idleContainerWorkspaces(idleMs)).catch((error) => log.error({ err: errStr(error) }, 'container reap threw'));
      await this.media.sweep().catch((error) => log.error({ err: errStr(error) }, 'media sweep threw'));
      await pressureSweep(this.settings, this.projects, this.sessions, this.sessionRunners, this.images, this.sessionContainers, this.git.sync, (ids) => this.busyWorkspaces(ids))
        .catch((error) => log.error({ err: errStr(error) }, 'pressure sweep threw'));
      return Number(await this.settings.resolve<number>('maintenance_interval_ms').catch(() => 60_000));
    }));
    // Database console lifecycle: stop CloudBeaver if the setting is off,
    // start it when toggled on. The boot reconciliation catches the container
    // compose started; the settings listener handles ongoing changes.
    void reconcileDbUi(this.docker, this.settings);
    this.settingsEvents.subscribe((change) => {
      if (change.keys.includes('db_ui_enabled')) void reconcileDbUi(this.docker, this.settings);
    });
    this.#loops.push(this.#loop(async () => {
      await refreshWorkState({ workspaces: this.workspaces, projects: this.projects, hosts: this.sessionRunners, sessionContainers: this.sessionContainers, boardEvents: this.boardEvents })
        .catch((error) => log.error({ err: errStr(error) }, 'work-state refresh threw'));
      return 10_000;
    }, 10_000));
  }

  /** A loop that runs `tick` until stop, sleeping what it answers (ms). */
  async #loop(tick: () => Promise<number>, firstDelayMs = 0): Promise<void> {
    if (firstDelayMs) await sleep(firstDelayMs);
    while (!this.#stopped) {
      const wait = await tick();
      await sleep(wait);
    }
  }

  get stopped(): boolean { return this.#stopped; }

  /** Run: the routes are built and the API listens — the backend's own
   *  engines and user space's are clients of this API, so it answers before
   *  they start — then the git service and the loops begin, then
   *  `config.onStart` (user space's engines). */
  async start(): Promise<void> {
    // A disk limit already set (or fixed) that this server cannot enforce:
    // stop here, by name — every agent would otherwise fail to start.
    if (await this.settings.resolve('container_disk_gb')) {
      const reason = await this.settings.unsupported('container_disk_gb');
      if (reason) throw new Error(`container_disk_gb is set but cannot be enforced on this server: ${reason}`);
    }
    await this.#httpApi.listen(this.env.port);
    if (this.sessionRunners.runsContainers) await this.sessionRunners.local.retireOldContainers();
    this.git.start();
    this.#startLoops();
    if (this.config.crons) { this.#cronScheduler = new CronScheduler(this, this.config.crons.agent); this.#cronScheduler.start(); }
    await this.config.onStart?.(this);
    log.info({ port: this.env.port, version: this.version }, 'backend up');
  }

  /** Stop in reverse: `config.onStop`, the git service, the API closes, the
   *  loops halt, the watcher ends, the database closes. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#cronScheduler?.stop();
    await this.config.onStop?.(this);
    await this.git.stop();
    await this.#httpApi.close();
    this.sessionRunners.stop();
    this.sessionRunners.local.stop();
    await this.database.close();
  }
}

interface Built {
  media: Media;
  env: Env; paths: Paths; database: Database; settings: Settings; projects: Projects; workspaces: Workspaces; sessions: Sessions;
  cards: Cards; crons: Crons; presets: Presets; backgroundTasks: BackgroundTasks; tokenLog: TokenLog; agentDatabases: AgentDatabases;
  agentTypes: AgentTypes; agentConfig: AgentConfig; modelCatalog: ModelCatalog; sessionNotes: SessionNotes;
  sessionEvents: SessionEvents; boardEvents: BoardEvents; settingsEvents: SettingsEvents; foregroundCommands: ForegroundCommands;
  docker: Docker; images: Images; sessionContainers: SessionContainers; sessionRunners: SessionRunners;
  telegramBotState: TelegramBotState; telegramSentMessages: TelegramSentMessages; telegramHandledUpdates: TelegramHandledUpdates;
}

const sleep = (milliseconds: number) => new Promise<void>((wake) => setTimeout(wake, milliseconds));
