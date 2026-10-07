-- The Telegram assistant's state per CHAT, not one row for the server: every
-- linked chat (the operator's, each user's, a project's group) has its own
-- mode and its own active session and project. The one row there was moves
-- to the operator's chat (the telegram_authorized_user setting).

create table phantom_looper.telegram_chat_state (
  chat_id            bigint  primary key,
  mode               text    not null default 'assistant',
  active_session_id  text    references phantom_agent_sdk.sessions(id) on delete set null,
  active_project_id  text    references phantom_agent_sdk.projects(id) on delete set null
);

insert into phantom_looper.telegram_chat_state (chat_id, mode, active_session_id, active_project_id)
  select (s.value #>> '{}')::bigint, t.mode, t.active_session_id, t.active_project_id
    from phantom_looper.telegram_assistant_state t
    join phantom_agent_sdk.settings s on s.scope = 'global' and s.namespace = 'general' and s.key = 'telegram_authorized_user'
   where t.id = 1 and (s.value #>> '{}') ~ '^[0-9]+$';

drop table phantom_looper.telegram_assistant_state;
