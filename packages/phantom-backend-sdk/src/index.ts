// @phantom-agent-sdk/backend — what a phantom backend runs. User space hands
// PhantomBackend.create a config and gets the backend back.
export { PhantomBackend, type PhantomBackendConfig } from './PhantomBackend.js';
export * from './members.js';
export type { SettingDefinition, AgentTypeDefinition, ToolDefinition, ToolRunContext, ToolGroup, ToolGrant, RouteRegistrar } from './doors.js';

// storage
export { SDK_MIGRATIONS, type Drizzle, type Transaction, type MigrationSet } from './storage/Database.js';
export * as schema from './storage/schema.js';
export { SettingsWriteError, type SettingScope, type SettingSource, type SettingLayers, type SettingEntry, type SettingMeta, type SecretMeta } from './storage/Settings.js';
export { sdkSettings, agentTypeSettings } from './storage/sdkSettings.js';
export type { TokenRecord, ReportRow, Windows, WindowTotals } from './storage/TokenLog.js';
export type { BackgroundTaskRow, BackgroundTaskEnd } from './storage/BackgroundTasks.js';
export { SqlError, locate, type QueryOptions, type StatementResult } from './storage/AgentDatabases.js';

// agents
export { AgentTypesError } from './agents/AgentTypes.js';
export { sessionPin, cascade, pinned, type ModelPin, type ResolvedModel, type AgentRunConfig, type CompactionSettings } from './agents/AgentConfig.js';
export { CATALOG_PROVIDERS, hasCatalog, fromModelsDev, fetchCatalog, writeSnapshot, type CatalogProvider, type CatalogModel, type Catalog, type CatalogSource } from './agents/ModelCatalog.js';

// lib
export { logger, errStr } from './lib/log.js';
export { Clock, TIMEZONES } from './lib/clock.js';
export { GLOBAL, projectScope } from './lib/scopes.js';
export { makePaths, sessionDir, repoDir, slotPrefix, slotUlid, type Paths } from './lib/paths.js';
export { encrypt, decrypt, timingSafeEqualStr } from './lib/crypto.js';

// the vocabulary both halves speak
export { newId, idTime, DEFAULT_COLUMNS, STATUS_ICON, normalizeKey, newKey, keyedItems, type ChecklistItem } from 'phantom-client-sdk';
export { PresetError, type PresetRow } from './storage/Presets.js';

// table owners' companions
export { ProjectError, defaultPrefix, columnsOf, type NewProject } from './storage/Projects.js';
export { WorkspaceError, type WorkRefreshWorkspace } from './storage/Workspaces.js';
export { CardError, CARD_FIELDS, CARD_JSON_FIELDS, type CardFields, type ItemOp } from './storage/Cards.js';
export { CronError, CRON_FIELDS, isOnce, nextFire, type CronFields } from './storage/Crons.js';
export { CAP_BYTES, capPart, type SessionEvent } from './agents/SessionEvents.js';
export type { BoardEvent } from './agents/BoardEvents.js';
export type { SettingsChanged } from './agents/SettingsEvents.js';

export { hasEmbeddedCredentials, parseGitHubUrl, parseRepoRef, remoteUrl } from './git/remote.js';
export type { CardRow, CronRow, ProjectRow, WorkspaceRow, SessionRow } from './storage/schema.js';
export * as checkoutPool from './runtime/CheckoutPool.js';
