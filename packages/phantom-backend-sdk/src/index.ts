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

// runtime, git, prompt, skills, tools — the moved modules' companions
export { makeDocker } from './runtime/Docker.js';
export { PullTracker } from './runtime/Images.js';
export { buildContainerSpec, type ContainerOpts } from './runtime/SessionContainers.js';
export type { RunOpts, RunResult } from './runtime/Sandbox.js';
export { systemSkills, systemSkillTree, SYSTEM_SKILLS_DIR, type SystemSkill, type SystemSkillTree } from './runtime/SystemSkills.js';
export { webSearch, webFetch, urlSlug, type SearchBody, type WebDeps } from './runtime/Web.js';
export { createRepo, listRepos, whoami, type GitHubRepo, type CreateRepoResult, type ListReposResult, type WhoamiResult } from './git/GitHub.js';
export { refreshWorkState, type WorkRefreshDeps } from './git/workRefresh.js';
export { SystemPromptError, SERVER_PROMPT_BLOCKS, SOUL_FILENAME, AGENTS_FILENAME, type SystemPromptSource, type ServerPromptBlockName } from './agents/SystemPrompt.js';
export { killProcessGroup } from './agents/ForegroundCommands.js';
export { toolSession, SESSION_HEADER } from './agents/sessionHeader.js';
export { SessionError, conversationOnly, heldByOther, isHeld, lineCount, ownsWorkspace, agentAfterSave, assertDuplicable, copyName, expiredHold, workspaceOf,
  BACKGROUND_AGENTS, CRON_CLIENT_ID, LOOP_CLIENT_ID, DUP_PREFIX, LAST_MESSAGE_CHARS, type ListQuery, type ListedSession, type SessionFull } from './storage/Sessions.js';
export { formatTokenReport, reportWindows, groupOf, type TokenGroup } from './storage/tokenReport.js';
export { ToolError, looksBinary, type Truncation } from './tools/envelope.js';
export { fuzzyFindAndReplace, formatNoMatchHint, findClosestLines, ratio, type FuzzyResult } from './tools/fuzzy.js';
export { SKILLS_DIR, scanSkills, mergeSkills, parseDescription, splitFrontmatter, type SkillMeta } from './skills/skills.js';
export { lintSkillMd, validateSkillMd, validateSkillName, validateFilePath, MAX_DESCRIPTION, MAX_FILE_BYTES, MAX_NAME, MAX_SKILL_CONTENT, FILE_SUBDIRS } from './skills/validate.js';
export { fill, withCurrentDate, firstLineOf } from './prompt/template.js';
export { SKILLS_LIST, SECRETS_LIST, GITHUB_TOKEN, AGENT_DATABASE, AGENT_DATABASE_SHARED, TIME_DATE } from './prompt/serverBlocks.js';

// telegram plumbing, notifications, the queue
export { titled, ALLOWED_UPDATES, MAX_OUTBOUND_BYTES, type SendKind } from './telegram/TelegramBot.js';
export { toTelegram, splitFormatted, truncateFormatted, clampEntities, type Formatted, type Entity as TelegramEntity } from './telegram/entities.js';
export { collectDeliverables, extractMedia, extractBarePaths, maskJsonStringMedia, maskProtectedSpans, validateDeliveryPath, deliveryKind, MEDIA_DELIVERY_EXTS, type Deliverable, type Media } from './telegram/mediaTags.js';
export { makeTelegramSink, type TelegramSink, type DeliverConfig } from './telegram/sink.js';
export { startWaitingBubble, type WaitingBubble } from './telegram/bubble.js';
export { writeAttachment, composeMessage, classify, safeName, sniffImageMime, MAX_INBOUND_BYTES, type StoredAttachment, type MediaKind } from './telegram/TelegramAttachments.js';
export { transcribeVoice, speakVoice, splitForSpeech, SPEAK_MAX_CHARS, type Transcription } from './telegram/TelegramVoice.js';
export { connectFetch, isConnectFailure, CONNECT_RETRIES, CONNECT_TIMEOUT_MS, KEEP_ALIVE_MS } from './telegram/connect.js';
export { askText, answeredText, parseAnswer, type Ask, type ApprovalClient } from './telegram/TelegramApprovals.js';
export { TelegramHandledUpdates } from './telegram/handledUpdates.js';
export { TelegramSentMessages, type TelegramSentMessage } from './telegram/sentMessages.js';
export { TelegramBotState, MODE_MESSAGE, type TelegramBotStateRow, type TelegramMode } from './telegram/botState.js';
export { telegramChannel } from './telegram/telegramChannel.js';
export { lastAssistantFromJsonl } from './telegram/transcriptHelper.js';
export type { NotificationChannel } from './Notifications.js';
