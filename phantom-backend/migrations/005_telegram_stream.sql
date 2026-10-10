-- /stream, per chat: what of the session it is on streams into the chat.
-- on   — every turn's replies, whoever drives the session (the default)
-- all  — the same, plus a message typed elsewhere shown above its reply
-- off  — only replies to what this chat sent
alter table phantom_looper.telegram_chat_state add column stream text not null default 'on';
