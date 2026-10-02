-- Where the session's code stands: not_pushed, not_merged, merged.
-- Updated by the server's periodic git-state refresh (every 10s for sessions
-- with an active container). Null = never checked or no checkout.
alter table phantom_looper.sessions add column if not exists work text;
