// phantom-client-sdk — build and run agents against a phantom-backend.
export { Agent, type AgentHandlers, type Notice, type SessionRow, type TokenTotals } from './agent.js';
export { CodingAgent, codingPromptBlocks, gatherWorkspaceFacts, type WorkspaceFacts } from './agents/coding/index.js';
export { SupervisorAgent, supervisorPromptBlocks, firstLine, toCodingAgent, toSupervisor, type CardShape } from './agents/supervisor/index.js';
export { AssistantAgent, assistantPromptBlocks } from './agents/assistant/index.js';

export { type PhantomBackend, call, callRaw, headersFor, SESSION_HEADER, CLIENT_HEADER, type Envelope } from './backend.js';
export { PhantomError, isPhantomError, isContextTooLong, ERROR_CODES, type ErrorCode } from './errors.js';
export { Relay, watchForInterrupt, RELAY_FLUSH_MS } from './feed.js';
export type { AgentEvents } from './events.js';

export { type LlmConfig, type CompactionConfig, type AgentKeys, llmConfigFrom, keysFrom, PROVIDERS, REASONINGS, isProvider, isReasoning,
  type Provider, type Reasoning } from './model/llmConfig.js';
export { languageModel, isAnthropicOAuth, withClaudeCodeIdentity, CLAUDE_CODE_SYSTEM, effectiveReasoning,
  type ModelSpec, type ModelHooks, type TokenUsage } from './model/languageModel.js';
export { withRetry, MODEL_RETRY, BACKEND_RETRY, RETRY_WAITS_S, RETRY_BUDGET_MS, type RetryPolicy } from './model/retry.js';
export { CACHE_TTL, CACHED_BLOCKS, systemMessages, withRollingCacheMark } from './model/cache.js';

export { type ToolKit, type ToolKitContext, type BuiltTools, ToolKitSet, guardReadonly, READONLY_REFUSAL } from './toolkit.js';
export { workspaceToolKit, readonlyWorkspaceToolKit } from './kits/workspace.js';
export { webToolKit } from './kits/web.js';
export { skillsToolKit } from './kits/skills.js';
export { secretsToolKit } from './kits/secrets.js';
export { cronsToolKit } from './kits/crons.js';
export { databaseToolKit } from './kits/database.js';
export { notifyToolKit } from './kits/notify.js';
export { kanbanToolKit, kanbanReadToolKit, loopSupervisorToolKit, loopBlockToolKit, renderCard,
  ENDING_TOOLS, SUPERVISOR_MOVES, DEFAULT_COLUMNS, type LoopColumn, type CardRow, type ItemOp } from './kits/kanban.js';
export { gitToolKit, autoPushSession, autoPullSession, AUTO_PUSH_STEPS, AUTO_PULL_STEPS,
  type AutoPushOutcome, type AutoPullOutcome, type GitToolKitOptions } from './kits/git.js';

export { Transcript, conversationFrom, parseLines, messageLine, usageLine, interruptedLine, compactionLine, lineId,
  type TranscriptLine, type MessageLine, type UsageLine, type InterruptedLine, type CompactionLine, type LoadedConversation } from './transcript.js';
export { runTurn, type TurnResult, type TurnUsage, type TurnInput, type StreamPart, type PendingMessages } from './turn.js';
export { MessageQueue, type QueueEntry } from './queues.js';
export { assistantMessageFrom, toolResultMessage, interruptedResultMessage, INTERRUPTED_RESULT, userMessage } from './messages.js';
export { fastStrategy, compactionStrategy, registerCompactionStrategy, compactionDue, planCompaction, writeSummary,
  type CompactionStrategy, type CompactionPlan } from './compaction.js';
export { fill, firstLineOf } from './prompts/template.js';
export { STAKEHOLDERS } from './prompts/stakeholders.js';
export { VALUES } from './prompts/values.js';
export { COMMUNICATION } from './prompts/communication.js';
export { ENVIRONMENT } from './prompts/environment.js';
export { SENDING_FILES } from './prompts/sending.js';
export { GIT } from './prompts/git.js';
export { todayFor } from './prompts/date.js';
