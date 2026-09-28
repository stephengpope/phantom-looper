// phantom-client-sdk — the agent runtime for a phantom-backend. An app
// subclasses Agent with its own prompt and kits; nothing about any
// particular agent lives here.

// The runtime.
export { Agent, type AgentHandlers, type Notice, type SessionRow, type TokenTotals } from './agent.js';
export type { AgentEvents } from './events.js';
export type { TurnResult, TurnUsage, StreamPart } from './turn.js';
export type { QueueEntry } from './clientUserMessageQueue.js';

// The backend client — for an app's own kits and calls.
export { type PhantomBackend, call, callRaw, headersFor, type Envelope } from './backend.js';
export { PhantomError, isPhantomError, isContextTooLong, ERROR_CODES, type ErrorCode } from './errors.js';

// A billed model for a one-shot call (a title, a commit message).
export { billedModel, type ModelSpec, type Billing, type ModelHooks, type TokenUsage } from './model/languageModel.js';
export { PROVIDERS, REASONINGS, isProvider, isReasoning, type Provider, type Reasoning, type LlmConfig, llmConfigFrom } from './model/llmConfig.js';
export type { RetryPolicy } from './model/retry.js';

// Tool kits: the mechanism, and the kits over the API's routes.
export { type ToolKit, type ToolKitContext, type BuiltTools } from './toolkit.js';
export { workspaceToolKit, readonlyWorkspaceToolKit } from './kits/workspace.js';
export { webToolKit } from './kits/web.js';
export { skillsToolKit } from './kits/skills.js';
export { secretsToolKit } from './kits/secrets.js';
export { cronsToolKit } from './kits/crons.js';
export { databaseToolKit } from './kits/database.js';
export { notifyToolKit } from './kits/notify.js';
export { kanbanToolKit, kanbanReadToolKit, type CardRow, type ItemOp } from './kits/kanban.js';
export { gitToolKit, autoPushSession, autoPullSession, type AutoPushOutcome, type AutoPullOutcome, type GitToolKitOptions } from './kits/git.js';

// The record's line format — the server reads and writes it too.
export { parseLines, conversationFrom, messageLine,
  type TranscriptLine, type MessageLine, type UsageLine, type InterruptedLine, type CompactionLine } from './transcript.js';
export { userMessage } from './messages.js';
