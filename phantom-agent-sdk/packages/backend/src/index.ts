// @phantom-agent-sdk/backend — what a phantom backend runs. User space hands
// PhantomBackend.create a config and gets the backend back.
export { PhantomBackend, type PhantomBackendConfig } from './PhantomBackend.js';
export * from './members.js';
export type { SettingDefinition, AgentTypeDefinition, ToolDefinition, ToolRunContext, ToolGroup, ToolGrant, RouteRegistrar, CardFieldsExtension } from './doors.js';

// storage
export { SDK_MIGRATIONS, ORGANIZATION_SETTING, USER_SETTING, type Drizzle, type Transaction, type MigrationSet } from './storage/Database.js';
export * as schema from './storage/schema.js';
export { SettingsWriteError, type SettingScope, type SettingSource, type SettingLayers, type SettingEntry, type SettingMeta, type SecretMeta } from './storage/Settings.js';
export { sdkSettings, agentTypeSettings } from './storage/sdkSettings.js';
export type { TokenRecord, ReportRow, Windows, WindowTotals } from './storage/TokenLog.js';
export type { BackgroundTaskRow, BackgroundTaskEnd } from './storage/BackgroundTasks.js';
export { MailerError, type Mail } from './mail/Mailer.js';
export { IdentityError, IDENTITY_PATH, type Caller, type IdentityOptions, type OrganizationRole, type OAuthApp, type MailTemplates, type MailBody } from './identity/Identity.js';
export { SqlError, locate, type QueryOptions, type StatementResult } from './storage/AgentDatabases.js';

// agents
export { AgentTypesError } from './agents/AgentTypes.js';
export { sessionPin, cascade, pinned, type ModelPin, type ResolvedModel, type AgentRunConfig, type CompactionSettings } from './agents/AgentConfig.js';
export { CATALOG_PROVIDERS, hasCatalog, fromModelsDev, fetchCatalog, writeSnapshot, type CatalogProvider, type CatalogModel, type Catalog, type CatalogSource } from './agents/ModelCatalog.js';

// lib
export { logger, errStr } from './lib/log.js';
export { Clock, TIMEZONES } from './lib/clock.js';
export { GLOBAL, LAYERS, projectScope, organizationScope, userScope, scopeOf, scopeNames, layerOf, type Layer, type OverridableLayer } from './lib/scopes.js';
export { makePaths, sessionDir, repoDir, slotPrefix, slotUlid, type Paths } from './lib/paths.js';
export { encrypt, decrypt, timingSafeEqualStr } from './lib/crypto.js';

// the vocabulary both halves speak
export { newId, idTime, DEFAULT_COLUMNS, STATUS_ICON, normalizeKey, newKey, keyedItems, type ChecklistItem } from '@phantom-agent-sdk/client';
export { PresetError, type PresetRow } from './storage/Presets.js';

// table owners' companions
export { ProjectError, defaultPrefix, columnsOf, type NewProject } from './storage/Projects.js';
export { WorkspaceError, type WorkRefreshWorkspace } from './storage/Workspaces.js';
export { CardError, CARD_FIELDS, CARD_JSON_FIELDS, type Card, type CardFields, type ItemOp } from './storage/Cards.js';
export { CronError, CRON_FIELDS, isOnce, nextFire, type CronFields } from './storage/Crons.js';
export { CAP_BYTES, capPart, type SessionEvent } from './agents/SessionEvents.js';
export type { BoardEvent } from './agents/BoardEvents.js';
export type { SettingsChanged } from './agents/SettingsEvents.js';

export { hasEmbeddedCredentials, parseGitHubUrl, parseRepoRef, remoteUrl } from './git/remote.js';
export type { CardRow, CronRow, ProjectRow, WorkspaceRow, SessionRow, UserRow, OrganizationRow, MemberRow, InvitationRow, ApiKeyRow } from './storage/schema.js';
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
export { SessionError, conversationOnly, heldByOther, isHeld, lineCount, ownsWorkspace, assertDuplicable, copyName, expiredHold, workspaceOf,
  DUP_PREFIX, LAST_MESSAGE_CHARS, type ListQuery, type ListedSession, type SessionFull, type StartOptions } from './storage/Sessions.js';
export { formatTokenReport, reportWindows, groupOf, type TokenGroup } from './storage/tokenReport.js';
export { ToolError, looksBinary, type Truncation } from './tools/envelope.js';
export { fuzzyFindAndReplace, formatNoMatchHint, findClosestLines, ratio, type FuzzyResult } from './tools/fuzzy.js';
export { SKILLS_DIR, scanSkills, mergeSkills, parseDescription, splitFrontmatter, type SkillMeta } from './skills/skills.js';
export { lintSkillMd, validateSkillMd, validateSkillName, validateFilePath, MAX_DESCRIPTION, MAX_FILE_BYTES, MAX_NAME, MAX_SKILL_CONTENT, FILE_SUBDIRS } from './skills/validate.js';
export { fill, withCurrentDate, firstLineOf } from './prompt/template.js';
export { SKILLS_LIST, SECRETS_LIST, GITHUB_TOKEN, AGENT_DATABASE, AGENT_DATABASE_SHARED, TIME_DATE } from './prompt/serverBlocks.js';

// telegram plumbing, notifications, the queue
export { TelegramApi, titled, ALLOWED_UPDATES, MAX_OUTBOUND_BYTES, type SendKind } from './telegram/TelegramApi.js';
export { collectFiles, type TelegramBotDeps, type TelegramCommand, type WebhookStatus, type MessageHandler, type ReactionHandler, type ButtonHandler, type ReplyBubble } from './telegram/TelegramBot.js';
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
export { TelegramBotState, type TelegramBotStateRow } from './telegram/botState.js';
export { telegramChannel } from './telegram/telegramChannel.js';
export { lastAssistantFromJsonl } from './telegram/transcriptHelper.js';
export { NotificationsError, type NotificationChannel } from './Notifications.js';
export { readEnv, APP_VERSION, API_IMAGE, type Env } from './lib/env.js';

// the API: envelope helpers and the route helpers user space's routes share
export { ok, err } from './api/HttpApi.js';
export { clientOf, lockedErr } from './api/routes/sessions.js';
export { fsDeps, fileTools, type FsDeps } from './api/routes/fs.js';
export { TOOLS, toolByName, toolsFor, grantedTools } from './tools/registry.js';
export { str, int, bool, nullable, oneOf, obj, s, refusal, type ToolDef, type ToolCtx, type OfferCtx, type FileTools, type PublishedTool } from './tools/def.js';
export { userMessagesContext, titleContext, cleanTitle, type TitleContext, type TitleWriter } from './agents/SessionTitler.js';

// git — what the app reads off a sync and brings to it (config.git)
export { syncStepLabel, type SyncEvent, type SyncResult, type SyncOptions, type SyncStep, type ConflictContext } from './git/sync.js';
export type { AutoPushEvent, AutoPushResult } from './git/autoPush.js';
export type { AutoPullEvent, AutoPullResult } from './git/autoPull.js';
export type { GitHooks, AutoPushFn, AutoPullFn } from './git/GitService.js';
export type { Arrival } from './git/GitSync.js';

// upgrade
export { Deployment, DeploymentError, LOG_MAX_BYTES, LOG_MAX_TAIL, LOG_SERVICES, type LogsQuery } from './upgrade/Deployment.js';
export { UpgradeChecker, type UpgradeCheckerDeps } from './upgrade/UpgradeChecker.js';
export { subscribe as subscribeUpdate, isRunning as updateRunning, shutdown as updateShutdown, startUpdate, HELPER_NAME, type UpdateDeps, type UpdateListener } from './upgrade/updateTask.js';
export { SDK_VERSION } from './sdkVersion.js';
