// PhantomBackend — the root of @phantom-agent-sdk/backend. One object owns
// every service, boots them in order, runs the API, and is the only thing
// user space talks to. User space does not subclass it: it hands `create`
// a config carrying its registrations (settings, agent types, tools,
// routes, hooks) and gets a backend back.
//
// `create` builds everything, connected but not running; `start` listens
// and begins the loops; `stop` winds down in reverse. The members are the
// objects every route, tool and engine reads — what used to be the `AppCtx`
// bag, now the backend itself.
import { readEnv, APP_VERSION, type Env } from './lib/env.js';
import { logger, errStr } from './lib/log.js';
import { makePaths, type Paths } from './lib/paths.js';
import { Database, SDK_MIGRATIONS } from './storage/Database.js';
import { Settings } from './storage/Settings.js';
import { sdkSettings, agentTypeSettings } from './storage/sdkSettings.js';
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
import { UserMessageQueue } from './agents/UserMessageQueue.js';
import { SessionEvents } from './agents/SessionEvents.js';
import { BoardEvents } from './agents/BoardEvents.js';
import { SettingsEvents } from './agents/SettingsEvents.js';
import { ForegroundCommands } from './agents/ForegroundCommands.js';
import { makeDocker } from './runtime/Docker.js';
import { Images } from './runtime/Images.js';
import { SessionContainers } from './runtime/SessionContainers.js';
import * as checkoutPool from './runtime/CheckoutPool.js';
import { WorkspaceWatcher } from './git/WorkspaceWatcher.js';
import { refreshWorkState } from './git/workRefresh.js';
import { TelegramBotState } from './telegram/botState.js';
import { TelegramSentMessages } from './telegram/sentMessages.js';
import { TelegramHandledUpdates } from './telegram/handledUpdates.js';
import { TelegramBot, type TelegramCommand } from './telegram/TelegramBot.js';
import type { SettingDefinition, AgentTypeDefinition, ToolDefinition, RouteRegistrar } from './doors.js';
import { Notifications } from './Notifications.js';
import { SessionTitler, type TitleWriter } from './agents/SessionTitler.js';
import { HttpApi } from './api/HttpApi.js';
import { registerTools } from './tools/registry.js';
import { reconcileDbUi } from './api/routes/dbUi.js';
import type { SessionRow, ProjectRow } from './storage/schema.js';
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
  /** The agent types this backend runs. The SDK ships none. */
  agentTypes: AgentTypeDefinition[];
  /** Tools user space serves from the backend, alongside the SDK's. */
  tools?: ToolDefinition[];
  /** Routes user space adds to the API, under the same auth. */
  routes?: RouteRegistrar;
  /** Run after every service is up and before the API listens. User space
   *  starts its engines here (the looper, its bot) with the backend in hand. */
  onStart?: (backend: PhantomBackend) => Promise<void>;
  /** Run first on stop, before the API closes. */
  onStop?: (backend: PhantomBackend) => Promise<void>;
  /** Transitional — what the backend still asks user space to do, until it
   *  does it itself on the client SDK (docs/phantom-agent-sdk-plan.md). */
  transitional?: {
    /** Write a session's title from the selected user messages (a model call). → SessionTitler on billedModel. */
    writeTitle?: TitleWriter;
  };
  /** The Telegram command menu the bot registers: the global default and
   *  the authorized chat's (its mode's). The commands are the app's. */
  telegramCommandMenu?: (state: import('./telegram/botState.js').TelegramBotStateRow) => Promise<{ global: TelegramCommand[]; forChat?: TelegramCommand[] }>;
}

/** What the backend still reaches user space through at run time. Each
 *  entry leaves with the plan step named on it. */
export interface Hooks {
  /** The git sync the session routes push and detach through. → GitSync (§4). */
  gitSync?: { push(session: SessionRow, project: ProjectRow): Promise<unknown>; detach(sessionId: string): Promise<void> };
  /** The card runs in flight — /health's `loops_running`. → the looper reads its own count (§5). */
  runningLoops?: () => number;
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
  readonly userMessageQueue: UserMessageQueue;
  readonly sessionEvents: SessionEvents;
  readonly boardEvents: BoardEvents;
  readonly settingsEvents: SettingsEvents;
  readonly foregroundCommands: ForegroundCommands;
  readonly notifications = new Notifications();
  readonly sessionTitler: SessionTitler;
  readonly httpApi: HttpApi;
  readonly hooks: Hooks = {};
  /** Turns the backend itself runs, by session id — the interrupt route
   *  aborts one. Goes when every turn runs on the client SDK. */
  readonly activeTurns = new Map<string, AbortController>();
  /** Where a client in this process reaches the API: plain HTTP on
   *  loopback. The backend's own agents are clients like any other. */
  get loopback(): { url: string; apiKey: string } {
    return { url: `http://127.0.0.1:${this.env.port}/api`, apiKey: this.env.apiKey };
  }

  // ── runtime ──────────────────────────────────────────────────────────
  readonly docker: Docker;
  readonly images: Images;
  readonly sessionContainers: SessionContainers;
  readonly workspaceWatcher: WorkspaceWatcher;

  // ── telegram tables ──────────────────────────────────────────────────
  readonly telegramBotState: TelegramBotState;
  readonly telegramSentMessages: TelegramSentMessages;
  readonly telegramHandledUpdates: TelegramHandledUpdates;
  readonly telegramBot: TelegramBot;

  #stopped = false;
  #loops: Promise<void>[] = [];

  private constructor(readonly config: PhantomBackendConfig, built: Built) {
    this.env = built.env; this.paths = built.paths; this.database = built.database; this.settings = built.settings;
    this.projects = built.projects; this.workspaces = built.workspaces; this.sessions = built.sessions; this.cards = built.cards;
    this.crons = built.crons; this.presets = built.presets; this.backgroundTasks = built.backgroundTasks; this.tokenLog = built.tokenLog;
    this.agentDatabases = built.agentDatabases; this.agentTypes = built.agentTypes; this.agentConfig = built.agentConfig;
    this.modelCatalog = built.modelCatalog; this.userMessageQueue = built.userMessageQueue; this.sessionEvents = built.sessionEvents;
    this.boardEvents = built.boardEvents; this.settingsEvents = built.settingsEvents; this.foregroundCommands = built.foregroundCommands;
    this.docker = built.docker; this.images = built.images; this.sessionContainers = built.sessionContainers;
    this.workspaceWatcher = built.workspaceWatcher; this.telegramBotState = built.telegramBotState;
    this.telegramSentMessages = built.telegramSentMessages; this.telegramHandledUpdates = built.telegramHandledUpdates;
    this.sessionTitler = new SessionTitler(this.sessions, config.transitional?.writeTitle);
    this.telegramBot = new TelegramBot({ settings: this.settings, settingsEvents: this.settingsEvents, botState: this.telegramBotState,
      sentMessages: this.telegramSentMessages, handledUpdates: this.telegramHandledUpdates, paths: this.paths,
      publicAddress: process.env.PHANTOM_BACKEND_ADDRESS, commandMenu: config.telegramCommandMenu });
    this.httpApi = new HttpApi(this, this.env.apiKey);
    if (config.routes) this.httpApi.addRoutes(config.routes);
  }

  /** Build every service, connected but not running. Boot order:
   *   1. env → Database → migrations: the SDK's, then user space's
   *   2. the three event feeds; ModelCatalog; AgentTypes (config.agentTypes)
   *   3. Settings — registered in screen order: each type's ten, the SDK's, user space's
   *   4. AgentConfig, AgentDatabases, Projects, Workspaces, Cards
   *   5. Docker, Images, Sessions (following the model settings), the rest of the table owners
   *   6. the Telegram tables, the queue, foreground commands, SessionContainers, the watcher
   *  Nothing listens or ticks until `start`. */
  static async create(config: PhantomBackendConfig, options: { sessionImageTag?: string; onContainerStarted?: (workspaceId: string, project: import('./storage/schema.js').ProjectRow | undefined) => Promise<void>; onContainerRemoved?: (workspaceId: string) => Promise<void> } = {}): Promise<PhantomBackend> {
    const env = readEnv(config.env ?? process.env);
    const database = Database.connect(env.databaseUrl);
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

    const settings = new Settings(database.drizzle, env.encryptionKey, modelCatalog, settingsEvents);
    for (const type of agentTypes.list()) settings.register(agentTypeSettings(type));
    settings.register(sdkSettings({ sessionImageTag: options.sessionImageTag ?? (/^v\d+\.\d+\.\d+/.test(APP_VERSION) ? APP_VERSION : 'latest') }));
    settings.register(config.settings ?? []);
    const agentConfig = new AgentConfig(settings, agentTypes, modelCatalog);

    const agentDatabases = new AgentDatabases(database.pool, env.databaseUrl, env.encryptionKey);
    const projects = new Projects(database.drizzle, settings, settingsEvents, agentDatabases);
    const workspaces = new Workspaces(database.drizzle, paths, settings, sessionEvents);
    const cards = new Cards(database.drizzle, projects, boardEvents);
    const docker = makeDocker();
    // THE image puller/remover — every pull and removal in this process goes through it so they never overlap.
    const images = new Images(docker);
    const sessions = new Sessions(database.drizzle, settings, agentConfig, projects, workspaces, sessionEvents, { paths, docker });
    // A settings write reaches every session nothing has been said to yet: its row takes the settings' model.
    settingsEvents.subscribe(() => {
      sessions.followModelSettings().catch((error) => log.warn({ err: errStr(error) }, 'newborn sessions could not follow the model settings'));
    });
    const backgroundTasks = new BackgroundTasks(database.drizzle);
    const presets = new Presets(database.drizzle, settings);
    const crons = new Crons(database.drizzle, settings);
    const tokenLog = new TokenLog(database.drizzle);
    const telegramBotState = new TelegramBotState(database.drizzle, env.encryptionKey);
    const telegramSentMessages = new TelegramSentMessages(database.drizzle);
    const telegramHandledUpdates = new TelegramHandledUpdates(database.drizzle);
    const userMessageQueue = new UserMessageQueue();
    const foregroundCommands = new ForegroundCommands();
    const workspaceWatcher = new WorkspaceWatcher();
    const sessionContainers = new SessionContainers(docker, images, paths, {
      volume: process.env.WORKSPACE_VOLUME, network: process.env.WORKSPACE_NETWORK, settings, databases: agentDatabases,
      onStarted: options.onContainerStarted, onRemoved: options.onContainerRemoved,
    });

    return new PhantomBackend(config, {
      env, paths, database, settings, projects, workspaces, sessions, cards, crons, presets, backgroundTasks, tokenLog, agentDatabases,
      agentTypes, agentConfig, modelCatalog, userMessageQueue, sessionEvents, boardEvents, settingsEvents, foregroundCommands,
      docker, images, sessionContainers, workspaceWatcher, telegramBotState, telegramSentMessages, telegramHandledUpdates,
    });
  }

  /** THE busy rule, for the idle timeout and disk cleanup alike: a
   *  workspace is busy while a background task runs there or any session
   *  on it holds a live lock — a turn is running. */
  async busyWorkspaces(ids: string[]): Promise<Set<string>> {
    const [tasks, held] = await Promise.all([this.backgroundTasks.sessionsWithRunning(ids), this.sessions.workspacesHeld(ids)]);
    return new Set([...tasks, ...held]);
  }

  /** Workspaces with a running container not touched for `idleMs` and not busy — what the idle reaper takes. */
  async idleContainerWorkspaces(idleMs: number): Promise<string[]> {
    const active = await this.sessionContainers.activeWorkspaces();
    const idle = await this.workspaces.listIdle(active, idleMs);
    const busy = await this.busyWorkspaces(idle);
    return idle.filter((id) => !busy.has(id));
  }

  /** Begin the backend's own loops: the maintenance loop (pool stock, idle
   *  reaping, the sweeps the caller supplies) and the work-state refresh.
   *  `sweeps` is transitional — the disk sweeps need the git engine, which
   *  is user-wired until GitSync lands. */
  startLoops(sweeps: { idleBackup(): Promise<void>; pressure(): Promise<void> }): void {
    this.#loops.push(this.#loop(async () => {
      await checkoutPool.tick(this.projects, this.settings, this.paths).catch((error) => log.error({ err: errStr(error) }, 'pool tick threw'));
      await sweeps.idleBackup().catch((error) => log.error({ err: errStr(error) }, 'idle backup sweep threw'));
      const idleMs = await this.settings.resolve<number>('container_idle_ms').catch(() => 30 * 60_000);
      await this.sessionContainers.reap(Number(idleMs), (ms) => this.idleContainerWorkspaces(ms)).catch((error) => log.error({ err: errStr(error) }, 'container reap threw'));
      await sweeps.pressure().catch((error) => log.error({ err: errStr(error) }, 'pressure sweep threw'));
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
      await refreshWorkState({ workspaces: this.workspaces, projects: this.projects, paths: this.paths, containers: this.sessionContainers, events: this.boardEvents })
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

  /** Run: the routes are built, `config.onStart` runs (user space's engines
   *  may call the API in-process from here), then the API listens. */
  async start(): Promise<void> {
    await this.httpApi.build();
    await this.config.onStart?.(this);
    await this.httpApi.listen(this.env.port);
    log.info({ port: this.env.port, version: this.version }, 'backend up');
  }

  /** Stop in reverse: `config.onStop`, the API closes, the loops halt, the
   *  watcher ends, the database closes. */
  async stop(): Promise<void> {
    this.#stopped = true;
    await this.config.onStop?.(this);
    await this.httpApi.close();
    this.workspaceWatcher.stop();
    await this.database.close();
  }
}

interface Built {
  env: Env; paths: Paths; database: Database; settings: Settings; projects: Projects; workspaces: Workspaces; sessions: Sessions;
  cards: Cards; crons: Crons; presets: Presets; backgroundTasks: BackgroundTasks; tokenLog: TokenLog; agentDatabases: AgentDatabases;
  agentTypes: AgentTypes; agentConfig: AgentConfig; modelCatalog: ModelCatalog; userMessageQueue: UserMessageQueue;
  sessionEvents: SessionEvents; boardEvents: BoardEvents; settingsEvents: SettingsEvents; foregroundCommands: ForegroundCommands;
  docker: Docker; images: Images; sessionContainers: SessionContainers; workspaceWatcher: WorkspaceWatcher;
  telegramBotState: TelegramBotState; telegramSentMessages: TelegramSentMessages; telegramHandledUpdates: TelegramHandledUpdates;
}

const sleep = (ms: number) => new Promise<void>((wake) => setTimeout(wake, ms));
