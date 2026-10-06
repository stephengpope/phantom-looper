// @phantom-agent-sdk/client — the agent runtime for a phantom-backend. An app
// extends Agent with its type and its prompt; the tools are the server's;
// nothing about any particular agent lives here.
export { Agent, type AgentHandlers, type Notice, type SendOptions } from './agent.js';
export type { SessionInfo, SessionRow } from './session.js';
export type { AgentEvents } from './events.js';
export type { TurnResult, StreamPart } from './turn.js';
export type { QueueEntry, UserMessages } from './userMessages.js';
export type { TokenTotals } from './transcript.js';

// The connection — for an app's own kits and calls.
export { BackendClient, PERSON, type BackendOptions, type CallOptions, type Envelope } from './backend.js';
export { PhantomError, isPhantomError, SDK_ERROR_CODES, type ErrorCode, type SdkErrorCode } from './errors.js';
export type { RetryPolicy } from './model/retry.js';

// Tools only the app can serve (`agent.addToolKit(kit)`).
export type { ToolKit, ToolKitContext, BuiltTools } from './toolkit.js';

// A billed model for an app's one-shot call (a title, a commit message).
export { billedModel, type Billing, type ModelHooks } from './model/languageModel.js';
export { PROVIDERS, REASONINGS, isProvider, keyedProviders, type ModelSpec, type Provider, type Reasoning } from './model/llmConfig.js';

// One connection for everything — the transport an app hands `BackendClient`.
export { BackendConnection, type BackendConnectionOptions } from './backendConnection.js';

// The system prompt: the layout an agent declares, the shape the row stores.
export { agentText, systemPromptBlocks, SYSTEM_PROMPT_SECTIONS,
  type SystemPromptLayout, type SystemPromptEntry, type SystemPromptSection, type StoredSystemPrompt } from './systemPrompt.js';

// Shared vocabulary both halves speak: ids (ULIDs) and the board's card
// shapes — status icons, requirement keys.
export { newId, idTime } from './ids.js';
export { DEFAULT_COLUMNS, STATUS_ICON, normalizeKey, newKey, keyedItems, type ChecklistItem } from './cards.js';
export { pullLine, type PullProgress, type UpdateEvent } from './update.js';
export { secretName, SECRET_NAME_RULE } from './secretName.js';
export { REPO, parseVersion, isBehind, bare, checkLatest } from './version.js';
export { ndjson } from './ndjson.js';
export { fill, firstLineOf } from './template.js';
export { SDK_VERSION } from './sdkVersion.js';
