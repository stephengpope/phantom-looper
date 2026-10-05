// Drizzle mirror of phantom-backend/migrations/*.sql — this app's own tables,
// in the app's schema. The SQL files are the source of truth (applied by the
// SDK's Database.migrate under config.migrations, after the SDK's own); this
// file exists for typed queries. The SDK's tables are the SDK's
// (phantom_agent_sdk, phantom-agent-sdk/packages/backend/src/storage/schema.ts).
import { pgSchema, text, integer } from 'drizzle-orm/pg-core';

export const phantomLooper = pgSchema('phantom_looper');

// The Telegram bot's behaviour (001): the ONE row, id pinned 1 — who answers
// a plain message, and the session and project the bot points at. The link
// itself (webhook, secret, bot name) is the SDK's telegram_bot_state. The
// pointers are foreign keys into the SDK's tables: a deleted session or
// project clears them, so no reader guards against a phantom.
// TelegramAssistantState (telegram/TelegramAssistantState.ts) is its one owner.
export const telegramAssistantState = phantomLooper.table('telegram_assistant_state', {
  id: integer('id').primaryKey().default(1),
  // 'assistant' (home) | 'code' (messages run coding turns on activeSessionId).
  mode: text('mode').notNull().default('assistant'),
  activeSessionId: text('active_session_id'),
  activeProjectId: text('active_project_id'),
});
