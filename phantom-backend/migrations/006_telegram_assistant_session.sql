-- Which assistant session a chat is on, on the chat's own row. Before, the
-- process remembered it and, after a restart, took the NEWEST assistant
-- session the bot had opened — for the service role's chat that spans every
-- user's, and inside an organization every member's: a chat could resume
-- someone else's conversation. The pointer is a foreign key: a deleted
-- session clears it, and the next turn opens a new one.
alter table phantom_looper.telegram_chat_state
  add column assistant_session_id text references phantom_agent_sdk.sessions(id) on delete set null;
