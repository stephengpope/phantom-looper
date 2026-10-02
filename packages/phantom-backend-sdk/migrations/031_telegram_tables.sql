-- Telegram's three tables named for what a row is, and their session and
-- workspace links keyed.
--
-- telegram_account → telegram_bot_state. The ONE row (id 1): who answers a
-- plain message (mode), the active session and workspace, and the webhook
-- registration. active_session_id / active_workspace_id were bare text: a
-- deleted session or workspace left the pointer dangling and every reader
-- guarded against it. Now foreign keys, cleared on delete.
--
-- telegram_sent → telegram_sent_messages. One row per message the bot sent,
-- so a reply or reaction to it can be traced to its conversation. `origin`
-- ('assistant' | 'session') and `origin_session_id` carried one fact; now
-- `session_id` alone (null = the assistant's bubble), keyed, gone with its
-- session — a reply to a bubble whose session is gone answers nothing.
--
-- telegram_update → telegram_handled_updates. One row per Telegram
-- update_id already handled (Telegram re-delivers; the repeat is dropped).

-- ── telegram_bot_state ────────────────────────────────────────────────────
alter table phantom_looper.telegram_account rename to telegram_bot_state;
alter index phantom_looper.telegram_account_pkey rename to telegram_bot_state_pkey;
alter table phantom_looper.telegram_bot_state
  rename constraint telegram_account_id_check to telegram_bot_state_id_check;

update phantom_looper.telegram_bot_state
   set active_session_id = null
 where active_session_id is not null
   and not exists (select 1 from phantom_looper.sessions s where s.id = active_session_id);
update phantom_looper.telegram_bot_state
   set active_workspace_id = null
 where active_workspace_id is not null
   and not exists (select 1 from phantom_looper.workspaces w where w.id = active_workspace_id);

alter table phantom_looper.telegram_bot_state
  add constraint telegram_bot_state_active_session_id_fkey
    foreign key (active_session_id) references phantom_looper.sessions(id) on delete set null,
  add constraint telegram_bot_state_active_workspace_id_fkey
    foreign key (active_workspace_id) references phantom_looper.workspaces(id) on delete set null;

-- ── telegram_sent_messages ────────────────────────────────────────────────
alter table phantom_looper.telegram_sent rename to telegram_sent_messages;
alter index phantom_looper.telegram_sent_pkey rename to telegram_sent_messages_pkey;
alter table phantom_looper.telegram_sent_messages rename column origin_session_id to session_id;

-- An assistant bubble carries no session, whatever the old column said.
update phantom_looper.telegram_sent_messages set session_id = null where origin <> 'session';
-- A session bubble whose session is gone: gone with it, as the key will do from now on.
delete from phantom_looper.telegram_sent_messages
 where session_id is not null
   and not exists (select 1 from phantom_looper.sessions s where s.id = session_id);

alter table phantom_looper.telegram_sent_messages drop column origin;
alter table phantom_looper.telegram_sent_messages
  add constraint telegram_sent_messages_session_id_fkey
    foreign key (session_id) references phantom_looper.sessions(id) on delete cascade;
-- The last-message-for-a-session read, and the cascade, walk this.
create index telegram_sent_messages_session_id_idx
  on phantom_looper.telegram_sent_messages (session_id, sent_at desc);

-- ── telegram_handled_updates ──────────────────────────────────────────────
alter table phantom_looper.telegram_update rename to telegram_handled_updates;
alter index phantom_looper.telegram_update_pkey rename to telegram_handled_updates_pkey;
