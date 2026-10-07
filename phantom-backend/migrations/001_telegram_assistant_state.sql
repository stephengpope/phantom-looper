-- This app's first migration, the schema split's app half (docs/v1-plan.md
-- §1): the Telegram bot's BEHAVIOUR — who answers a plain message (mode), the
-- session and project it points at — leaves the SDK's link row
-- (phantom_agent_sdk.telegram_bot_state, which keeps the webhook registration
-- and the bot's name) for a table of the app's own. The pointers stay foreign
-- keys, cleared on delete, as they were (SDK migration 031).
--
-- Installs from before SDK migration 059 also copied the three columns out
-- of the SDK's table here and dropped them. An app's migrations may no
-- longer alter an SDK table (they run as app_migrator), so SDK 059 drops
-- them itself; a fresh install has no row to copy (the app makes it on
-- first read).

create table phantom_looper.telegram_assistant_state (
  id                 integer primary key default 1 check (id = 1),
  mode               text    not null default 'assistant',
  active_session_id  text    references phantom_agent_sdk.sessions(id) on delete set null,
  active_project_id  text    references phantom_agent_sdk.projects(id) on delete set null
);
