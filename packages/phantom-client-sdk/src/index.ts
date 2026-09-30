// phantom-client-sdk — the agent runtime for a phantom-backend. An app
// extends Agent with its type and its prompt; the tools are the server's;
// nothing about any particular agent lives here.
export { Agent, type AgentHandlers, type Notice } from './agent.js';
export type { SessionInfo, SessionRow } from './session.js';
export type { AgentEvents } from './events.js';
export type { TurnResult, StreamPart } from './turn.js';
export type { QueueEntry, UserMessages } from './userMessages.js';
export type { TokenTotals } from './transcript.js';

// The connection — for an app's own kits and calls.
export { PhantomBackend, type BackendOptions, type CallOptions, type Envelope } from './backend.js';
export { PhantomError, isPhantomError, ERROR_CODES, type ErrorCode } from './errors.js';
export type { RetryPolicy } from './model/retry.js';

// Tools only the app can serve (`agent.use(kit)`).
export type { ToolKit, ToolKitContext, BuiltTools } from './toolkit.js';

// A billed model for an app's one-shot call (a title, a commit message).
export { billedModel, type Billing, type ModelHooks } from './model/languageModel.js';
export type { ModelSpec, Provider, Reasoning } from './model/llmConfig.js';

// One connection for everything — the transport an app hands `PhantomBackend`.
export { ServerConnection, type ServerConnectionOptions } from './serverConnection.js';
