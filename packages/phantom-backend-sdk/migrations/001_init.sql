-- phantom-looper control plane, from birth. One migration, written the way
-- the code already thinks — cards not tasks, transcripts keyed by
-- (session, agent), sessions carrying who drives them, settings without a
-- namespace dimension.
create schema if not exists phantom_looper;

-- Rows exist ONLY for explicit overrides; absence means "use the code default".
-- A row is (scope, key): scope is the layer — global | workspace:<id> |
-- session:<id> — most specific winning. The two CHECKs make a plaintext secret
-- and an encrypted non-secret unrepresentable; not a convention — the DB
-- refuses.
create table phantom_looper.settings (
  scope      text not null default 'global',
  key        text not null,
  value      jsonb,
  value_enc  bytea,
  secret     boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (scope, key),
  constraint settings_one_value      check ((value is null) <> (value_enc is null)),
  constraint settings_enc_iff_secret check (secret = (value_enc is not null))
);

create table phantom_looper.workspaces (
  id             text primary key,
  url            text not null,
  owner          text not null,
  name           text not null,
  display_name   text,
  base_branch    text not null,
  branch_prefix  text not null default 'agent',
  schema_name    text not null unique,
  kanban_columns jsonb,
  created_at     timestamptz not null default now(),
  unique (owner, name)
);

create table phantom_looper.sessions (
  id              text primary key,
  workspace_id    text not null references phantom_looper.workspaces(id) on delete restrict,
  branch          text not null,
  claim_sha       text not null,
  status          text not null,
  -- Who drives this session: 'supervisor' for a looper-run card session, null
  -- for a person's coding session. Stamped ONLY by the loop path, so
  -- "agent = 'supervisor' and card = N" is trustworthy discovery state.
  agent           text,
  card            int,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz not null default now(),
  last_push_at    timestamptz,
  -- The session lock: which client holds the conversation, until when. Expiry
  -- is the whole recovery story — there is no takeover, only duplicate.
  locked_by       text,
  locked_label    text,
  lock_expires_at timestamptz
);

-- A session's conversations, whole — the same JSONL the client keeps as its
-- working memory. One row per (session, agent): the coding conversation and
-- the supervisor's conversation both live on the card's session.
create table phantom_looper.transcripts (
  session_id        text not null references phantom_looper.sessions(id) on delete cascade,
  agent             text not null default 'coding',
  data              text not null,
  last_user_message text,
  updated_at        timestamptz not null default now(),
  primary key (session_id, agent)
);

create table phantom_looper.commands (
  id          text primary key,
  session_id  text not null references phantom_looper.sessions(id) on delete cascade,
  argv        jsonb not null,
  status      text not null,
  exit_code   int,
  log_path    text not null,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);

-- Which version each per-workspace schema is at (db/workspaceSchema.ts).
create table phantom_looper.workspace_schema_state (
  workspace_id text primary key references phantom_looper.workspaces(id) on delete cascade,
  version      int not null default 0
);
