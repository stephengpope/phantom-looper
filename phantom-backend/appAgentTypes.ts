// The three agent types this app runs, registered through the agent-type
// door. The SDK ships no types: what a coder, a supervisor and an
// assistant ARE — which tools, which workspace relationship, whether their
// sessions show in lists, and what each of their settings means to a
// person — is said here and nowhere else. Registration order is the
// settings screen's order. The coding agent is the root: the assistant's
// and the supervisor's models fall back to it.
import type { AgentTypeDefinition, OverridableLayer } from '@phantom-agent-sdk/backend';
/** Whatever a project may override, an organization and a user may too — a bigger project. */
const SHARED: readonly OverridableLayer[] = ['organization', 'user', 'project'];

export const appAgentTypes: AgentTypeDefinition[] = [
  {
    // Writes code in its own checkout. Everything.
    name: 'coding',
    workspace: 'own',
    tools: ['bash', 'task_list', 'task_wait', 'task_kill', 'read', 'write', 'edit', 'ls', 'find', 'grep', 'skill_list', 'skill_load', 'skill_manage', 'web_search', 'web_fetch', 'secret_list', 'secret_get', 'cron_list', 'cron_create', 'cron_update', 'cron_remove', 'database_query', 'kanban_card_read', 'send_message'],
    listed: 'always',
    settings: {
      provider: { description: "The coding agent's LLM provider. Its key is set on /keys. Nothing runs until one is chosen. Per project: override on the project — set its provider first, then its model.", overridableAt: SHARED },
      model: { description: "Model id for the chosen provider. Empty = the newest model the catalog lists for it, so it follows releases. A project with its own provider picks its own model.", overridableAt: SHARED },
      base_url: { description: "Endpoint for openai / openai-compatible. Required by openai-compatible.", overridableAt: SHARED },
      reasoning: { description: "How much the model thinks before answering. Providers map this to their own setting.", default: "medium", overridableAt: SHARED },
      max_steps: { description: "Tool calls allowed per turn before the agent must stop and answer. Empty = unlimited.", overridableAt: SHARED },
      context_window: { description: "Context window size in tokens — fallback for when the model catalog doesn't know your model. Empty = use the catalog (the normal path).", overridableAt: SHARED },
      compact_threshold_pct: { description: "Percentage of the model's context window that triggers auto-compaction. 0 = off. Checked after every turn.", default: 0, overridableAt: SHARED },
      compact_strategy: { description: "The compaction strategy. fast = user/assistant text only.", default: "fast", overridableAt: SHARED },
      compact_summarize_pct: { description: "Percentage of user+assistant messages to summarize when compaction fires. The rest stay as-is.", default: 75, overridableAt: SHARED },
      compact_max_tokens: { description: "Output token cap for the compaction summary. Empty = the model decides how long the summary is.", overridableAt: SHARED },
    },
  },
  {
    // The user's assistant: works the board and the sessions, reads the
    // files of whatever session is on screen.
    name: 'assistant',
    modelFallsBackTo: 'coding',
    workspace: 'borrow',
    tools: ['task_list', 'task_wait', 'read', 'ls', 'find', 'grep', 'web_search', 'web_fetch', 'cron_list', 'cron_create', 'cron_update', 'cron_remove', 'kanban_card_read', 'kanban_card_list', 'kanban_card_create', 'kanban_card_update', 'kanban_card_items', 'kanban_card_auto_plan', 'kanban_card_auto_build', 'kanban_card_pin', 'kanban_card_move', 'kanban_card_history', 'git_auto_push', 'git_auto_pull'],
    listed: 'never',
    settings: {
      provider: { description: "The AI provider the Assistant answers on, on its key from /keys. Empty = the coding agent's provider." },
      model: { description: "Model the Assistant answers with. Empty = the coding agent's model; required when the provider differs from the coding agent's. A small fast model keeps replies quick." },
      base_url: { description: "Endpoint when the Assistant's provider is openai-compatible. Empty inherits the coding agent's only while the provider matches." },
      reasoning: { description: "How much the Assistant thinks before answering. Empty = the coding agent's reasoning level." },
      max_steps: { description: "Tool calls allowed per turn for the Assistant. Empty = unlimited." },
      context_window: { description: "Context window override for the Assistant. Empty = the coding agent's context window." },
      compact_threshold_pct: { description: "Auto-compaction threshold for the Assistant. 0 = off. Default 50%.", default: 50 },
      compact_strategy: { description: "Compaction strategy for the Assistant. Empty = the coding agent's strategy.", default: "fast" },
      compact_summarize_pct: { description: "Summarize % for the Assistant. Empty = the coding agent's summarize %." },
      compact_max_tokens: { description: "Summary output cap for the Assistant. Empty = the coding agent's cap." },
    },
  },
  {
    // Judges a card run: reads the coder's checkout, never writes it. Its
    // card-bound powers (move, items) are the looper's own tools, added per run.
    name: 'supervisor',
    modelFallsBackTo: 'coding',
    workspace: 'borrow',
    tools: ['task_list', 'task_wait', 'read', 'ls', 'find', 'grep', 'web_search', 'web_fetch', 'kanban_card_read'],
    listed: 'background',
    settings: {
      provider: { description: "The AI provider the supervisor judges on, on its key from /keys. Empty = the coding agent's provider." },
      model: { description: "Model the supervisor judges with. Empty = the coding agent's model; required when the provider differs from the coding agent's." },
      base_url: { description: "Endpoint when the supervisor's provider is openai-compatible. Empty inherits the coding agent's only while the provider matches." },
      reasoning: { description: "How much the supervisor thinks before answering. Empty = the coding agent's reasoning level." },
      max_steps: { description: "Tool calls allowed per turn for the supervisor. Empty = unlimited." },
      context_window: { description: "Context window override for the Supervisor. Empty = the coding agent's context window." },
      compact_threshold_pct: { description: "Auto-compaction threshold for the Supervisor. Empty = the coding agent's threshold." },
      compact_strategy: { description: "Compaction strategy for the Supervisor. Empty = the coding agent's strategy." },
      compact_summarize_pct: { description: "Summarize % for the Supervisor. Empty = the coding agent's summarize %." },
      compact_max_tokens: { description: "Summary output cap for the Supervisor. Empty = the coding agent's cap." },
    },
  },
];
