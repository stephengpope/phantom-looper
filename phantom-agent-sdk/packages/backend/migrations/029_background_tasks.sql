-- `commands` held one row per detached bash command a session's agent runs
-- — what the cli calls a task on /tasks and the agent reaches through the
-- task_* tools. "Command" also names the cli's slash commands and the
-- Telegram bot's commands: three meanings, one word. The table is named for
-- what it stores: a background task. Constraint names follow so `\d` reads
-- true.
alter table phantom_looper.commands rename to background_tasks;
alter table phantom_looper.background_tasks rename constraint commands_pkey to background_tasks_pkey;
alter table phantom_looper.background_tasks rename constraint commands_session_id_fkey to background_tasks_session_id_fkey;
