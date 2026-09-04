-- Telegram: one account (single-user, DM-only), the sent-bubble map, and
-- webhook update dedup. State, not settings: the mode pointer, the active
-- session and the webhook registration have no default/override semantics.

-- ONE row, id pinned to 1. mode says where a plain message goes:
-- 'assistant' (home — the Assistant answers) or 'code' (a coding turn on
-- active_session_id). webhook_secret_enc is minted at registration and
-- compared timing-safe on every update (encrypted like every stored
-- credential); webhook_url records what was last registered so the boot
-- reconcile can tell a stale registration from a current one.
create table phantom_looper.telegram_account (
  id integer primary key default 1 check (id = 1),
  mode text not null default 'assistant',
  active_session_id text,
  active_workspace_id text,
  webhook_secret_enc bytea,
  webhook_url text,
  bot_username text
);

-- Every text bubble the bot sends, recorded by the client's onSent hook —
-- a row exists because a message went out. (chat, message id) is all a
-- reply or reaction update carries, and this is what makes either
-- answerable: origin says which conversation the bubble belongs to
-- ('assistant', or 'session' + origin_session_id), content is what a
-- reaction reads back as audio. Never expired; deleted with the message.
create table phantom_looper.telegram_sent (
  chat_id bigint not null,
  message_id bigint not null,
  content text not null,
  origin text not null default 'assistant',
  origin_session_id text,
  sent_at timestamptz not null default now(),
  primary key (chat_id, message_id)
);

-- Webhook retry dedup: insert-on-conflict-do-nothing; a second delivery of
-- the same update_id loses the insert and is dropped.
create table phantom_looper.telegram_update (
  update_id bigint primary key,
  seen_at timestamptz not null default now()
);
