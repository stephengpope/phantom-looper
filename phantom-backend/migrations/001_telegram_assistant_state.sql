-- This app's first migration, the schema split's app half (docs/v1-plan.md
-- §1): the Telegram bot's BEHAVIOUR — who answers a plain message (mode), the
-- session and project it points at — leaves the SDK's link row
-- (phantom_agent_sdk.telegram_bot_state, which keeps the webhook registration
-- and the bot's name) for a table of the app's own. The pointers stay foreign
-- keys, cleared on delete, as they were (SDK migration 031).
--
-- The three columns are taken OUT of the SDK's table here, by the app: the
-- SDK's migrations run first at every boot, so a drop on the SDK's side
-- would run before this copy and lose the row. The app owns the fact; the
-- app's migration moves it. (An install of another app on the SDK keeps
-- three unused nullable columns from 012/031 until the SDK's own migrations
-- drop them.)

create table phantom_looper.telegram_assistant_state (
  id                 integer primary key default 1 check (id = 1),
  mode               text    not null default 'assistant',
  active_session_id  text    references phantom_agent_sdk.sessions(id) on delete set null,
  active_project_id  text    references phantom_agent_sdk.projects(id) on delete set null
);

insert into phantom_looper.telegram_assistant_state (id, mode, active_session_id, active_project_id)
  select id, mode, active_session_id, active_project_id
    from phantom_agent_sdk.telegram_bot_state where id = 1;

alter table phantom_agent_sdk.telegram_bot_state
  drop column mode,
  drop column active_session_id,
  drop column active_project_id;
