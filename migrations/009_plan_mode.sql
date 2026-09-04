-- /plan: plan mode for a session — the cli builds the coding agent's mutating
-- kits with the readonly preset while it is on. A fact about the session, so
-- it lives on the row (like name); every new session starts in code mode.
alter table phantom_looper.sessions add column plan_mode boolean not null default false;
