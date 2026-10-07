-- Every owned row carries its organization and the user who made it, and
-- one policy shape fences every table: a row is the caller's when its
-- organization is the caller's (docs/permissions.md).
--
-- - The operator's own organization ('operator'): what the server key
--   makes without naming anyone. No null "nobody's" rows remain.
-- - organization_id on every owned table. A top-level row (project, media)
--   takes the caller's organization, else the operator's. A row under a
--   parent takes its parent's, set by a trigger, and a composite foreign
--   key keeps it from ever drifting from the parent's.
-- - user_id on every owned table: the caller who made it (null = the
--   operator, or a user since deleted).
-- - log_tokens becomes token_usage, owned like the rest.
-- - settings get organization_id / user_id / project_id, derived from
--   their scope, for their policy.
-- - Grants to `authenticated` are explicit from here: what this file grants
--   is all it has. Identity is read-only to it (Better Auth writes, as
--   backend); operator-only tables are not granted at all.

-- ── the operator's organization ─────────────────────────────────────────
insert into identity.organization (id, name, slug, created_at)
values ('operator', 'Operator', 'operator', now()) on conflict (id) do nothing;

create or replace function phantom_agent_sdk.operator_organization() returns text
language sql immutable as $$ select 'operator'::text $$;

-- A row under a parent takes the parent's organization. Read as the
-- caller: a parent the caller cannot see is refused as the policies refuse
-- (insufficient_privilege — the API's one "access denied"), never quietly
-- re-homed. tg_argv: the parent table, the column naming the parent.
create or replace function phantom_agent_sdk.inherit_organization() returns trigger
language plpgsql as $fn$
declare parent_id text := to_jsonb(new) ->> tg_argv[1];
begin
  if parent_id is not null then
    execute format('select organization_id from phantom_agent_sdk.%I where id::text = $1', tg_argv[0])
      into new.organization_id using parent_id;
    if new.organization_id is null then
      raise exception 'access denied' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end
$fn$;

-- ── projects (top-level) ────────────────────────────────────────────────
update phantom_agent_sdk.projects set organization_id = 'operator' where organization_id is null;
alter table phantom_agent_sdk.projects
  alter column organization_id set default coalesce(phantom_agent_sdk.caller_organization(), phantom_agent_sdk.operator_organization()),
  alter column organization_id set not null,
  add column user_id text default phantom_agent_sdk.caller_user() references identity."user"(id) on delete set null,
  add constraint projects_id_organization_key unique (id, organization_id);
alter table phantom_agent_sdk.projects drop constraint projects_organization_owner_name_key;
alter table phantom_agent_sdk.projects add constraint projects_organization_owner_name_key unique (organization_id, owner, name);

-- ── media (top-level) ───────────────────────────────────────────────────
update phantom_agent_sdk.media set organization_id = 'operator' where organization_id is null;
alter table phantom_agent_sdk.media
  alter column organization_id set default coalesce(phantom_agent_sdk.caller_organization(), phantom_agent_sdk.operator_organization()),
  alter column organization_id set not null,
  alter column user_id set default phantom_agent_sdk.caller_user();

-- ── under a project: workspaces, sessions, cards, crons ─────────────────
do $$
declare t text;
begin
  foreach t in array array['workspaces', 'sessions', 'cards', 'crons'] loop
    execute format('alter table phantom_agent_sdk.%I add column organization_id text, add column user_id text default phantom_agent_sdk.caller_user() references identity."user"(id) on delete set null', t);
    execute format('update phantom_agent_sdk.%I c set organization_id = p.organization_id from phantom_agent_sdk.projects p where p.id = c.project_id', t);
    execute format('alter table phantom_agent_sdk.%I alter column organization_id set not null', t);
    execute format('alter table phantom_agent_sdk.%I drop constraint %I', t, t || '_project_id_fkey');
    execute format('alter table phantom_agent_sdk.%I add constraint %I foreign key (project_id, organization_id) references phantom_agent_sdk.projects (id, organization_id) on delete cascade', t, t || '_project_organization_fkey');
    execute format('create index %I on phantom_agent_sdk.%I (organization_id)', t || '_organization_id_idx', t);
    execute format('create trigger inherit_organization before insert on phantom_agent_sdk.%I for each row execute function phantom_agent_sdk.inherit_organization(''projects'', ''project_id'')', t);
  end loop;
end $$;
alter table phantom_agent_sdk.workspaces add constraint workspaces_id_organization_key unique (id, organization_id);
alter table phantom_agent_sdk.sessions add constraint sessions_id_organization_key unique (id, organization_id);
alter table phantom_agent_sdk.cards add constraint cards_id_organization_key unique (id, organization_id);

-- A session's checkout and card are its own organization's too.
alter table phantom_agent_sdk.sessions drop constraint sessions_workspace_id_fkey;
alter table phantom_agent_sdk.sessions add constraint sessions_workspace_organization_fkey
  foreign key (workspace_id, organization_id) references phantom_agent_sdk.workspaces (id, organization_id);
alter table phantom_agent_sdk.sessions drop constraint sessions_card_id_fkey;
alter table phantom_agent_sdk.sessions add constraint sessions_card_organization_fkey
  foreign key (card_id, organization_id) references phantom_agent_sdk.cards (id, organization_id) on delete set null (card_id);

-- ── card_revisions (under a card) ───────────────────────────────────────
alter table phantom_agent_sdk.card_revisions
  add column organization_id text,
  add column user_id text default phantom_agent_sdk.caller_user() references identity."user"(id) on delete set null;
update phantom_agent_sdk.card_revisions r set organization_id = c.organization_id from phantom_agent_sdk.cards c where c.id = r.card_id;
alter table phantom_agent_sdk.card_revisions alter column organization_id set not null;
alter table phantom_agent_sdk.card_revisions drop constraint card_revisions_card_id_fkey;
alter table phantom_agent_sdk.card_revisions add constraint card_revisions_card_organization_fkey
  foreign key (card_id, organization_id) references phantom_agent_sdk.cards (id, organization_id) on delete cascade;
create index card_revisions_organization_id_idx on phantom_agent_sdk.card_revisions (organization_id);
create trigger inherit_organization before insert on phantom_agent_sdk.card_revisions
  for each row execute function phantom_agent_sdk.inherit_organization('cards', 'card_id');

-- ── background_tasks (under a session) ──────────────────────────────────
alter table phantom_agent_sdk.background_tasks
  add column organization_id text,
  add column user_id text default phantom_agent_sdk.caller_user() references identity."user"(id) on delete set null;
update phantom_agent_sdk.background_tasks b set organization_id = s.organization_id from phantom_agent_sdk.sessions s where s.id = b.session_id;
alter table phantom_agent_sdk.background_tasks alter column organization_id set not null;
alter table phantom_agent_sdk.background_tasks drop constraint background_tasks_session_id_fkey;
alter table phantom_agent_sdk.background_tasks add constraint background_tasks_session_organization_fkey
  foreign key (session_id, organization_id) references phantom_agent_sdk.sessions (id, organization_id) on delete cascade;
create index background_tasks_organization_id_idx on phantom_agent_sdk.background_tasks (organization_id);
create trigger inherit_organization before insert on phantom_agent_sdk.background_tasks
  for each row execute function phantom_agent_sdk.inherit_organization('sessions', 'session_id');

-- ── media's project and session are its own organization's ──────────────
alter table phantom_agent_sdk.media drop constraint media_project_id_fkey;
alter table phantom_agent_sdk.media add constraint media_project_organization_fkey
  foreign key (project_id, organization_id) references phantom_agent_sdk.projects (id, organization_id) on delete set null (project_id);
alter table phantom_agent_sdk.media drop constraint media_session_id_fkey;
alter table phantom_agent_sdk.media add constraint media_session_organization_fkey
  foreign key (session_id, organization_id) references phantom_agent_sdk.sessions (id, organization_id) on delete set null (session_id);

-- ── token_usage (was log_tokens) ────────────────────────────────────────
-- Outlives its session on purpose (spend is history); goes with its
-- organization. A row naming a session takes the session's organization
-- and project — a session the caller cannot see is refused; one that names
-- none is the caller's.
alter table phantom_agent_sdk.log_tokens rename to token_usage;
alter table phantom_agent_sdk.token_usage rename constraint log_tokens_pkey to token_usage_pkey;
alter table phantom_agent_sdk.token_usage
  add column organization_id text,
  add column project_id text,
  add column user_id text default phantom_agent_sdk.caller_user() references identity."user"(id) on delete set null;
update phantom_agent_sdk.token_usage t set organization_id = s.organization_id, project_id = s.project_id
  from phantom_agent_sdk.sessions s where s.id = t.session_id;
update phantom_agent_sdk.token_usage set organization_id = 'operator' where organization_id is null;
alter table phantom_agent_sdk.token_usage
  alter column organization_id set default coalesce(phantom_agent_sdk.caller_organization(), phantom_agent_sdk.operator_organization()),
  alter column organization_id set not null,
  add constraint token_usage_organization_fkey foreign key (organization_id) references identity.organization(id) on delete cascade;
create index token_usage_organization_id_idx on phantom_agent_sdk.token_usage (organization_id);
create or replace function phantom_agent_sdk.token_usage_owner() returns trigger
language plpgsql as $fn$
begin
  if new.session_id is not null then
    select s.organization_id, s.project_id into new.organization_id, new.project_id
      from phantom_agent_sdk.sessions s where s.id = new.session_id;
    if new.organization_id is null then
      -- Gone (spend outlives sessions, so a late write may name one already
      -- deleted) is the server's to record; a session the CALLER cannot see
      -- is refused.
      if phantom_agent_sdk.caller_organization() is not null then
        raise exception 'access denied' using errcode = 'insufficient_privilege';
      end if;
      new.organization_id := phantom_agent_sdk.operator_organization();
    end if;
  end if;
  return new;
end
$fn$;
create trigger token_usage_owner before insert on phantom_agent_sdk.token_usage
  for each row execute function phantom_agent_sdk.token_usage_owner();

-- ── settings: the scope's owner as columns ──────────────────────────────
alter table phantom_agent_sdk.settings
  add column organization_id text generated always as (case when scope like 'organization:%' then substring(scope from 14) end) stored,
  add column user_id text generated always as (case when scope like 'user:%' then substring(scope from 6) end) stored,
  add column project_id text generated always as (case when scope like 'project:%' then substring(scope from 9) end) stored;

-- ── policies: one shape everywhere ──────────────────────────────────────
drop policy by_organization on phantom_agent_sdk.projects;
drop policy by_project on phantom_agent_sdk.workspaces;
drop policy by_project on phantom_agent_sdk.sessions;
drop policy by_project on phantom_agent_sdk.cards;
drop policy by_project on phantom_agent_sdk.crons;
drop policy by_card on phantom_agent_sdk.card_revisions;
drop policy by_organization on phantom_agent_sdk.media;
drop function phantom_agent_sdk.visible_project(text);
do $$
declare t text;
begin
  foreach t in array array['projects', 'workspaces', 'sessions', 'cards', 'card_revisions', 'crons', 'background_tasks', 'media', 'token_usage'] loop
    execute format('alter table phantom_agent_sdk.%I enable row level security', t);
    execute format('create policy tenant on phantom_agent_sdk.%I to authenticated using (organization_id = (select phantom_agent_sdk.caller_organization())) with check (organization_id = (select phantom_agent_sdk.caller_organization()))', t);
  end loop;
end $$;
-- Settings: the caller's organization's rows, the caller's own rows, and
-- the rows of projects the caller can see (that read is itself fenced).
create policy tenant on phantom_agent_sdk.settings to authenticated
  using (organization_id = (select phantom_agent_sdk.caller_organization())
      or user_id = (select phantom_agent_sdk.caller_user())
      or (project_id is not null and exists (select from phantom_agent_sdk.projects p where p.id = project_id)))
  with check (organization_id = (select phantom_agent_sdk.caller_organization())
      or user_id = (select phantom_agent_sdk.caller_user())
      or (project_id is not null and exists (select from phantom_agent_sdk.projects p where p.id = project_id)));

-- ── grants to `authenticated`: explicit, and only these ─────────────────
-- Before this file every table in every schema was granted; from here a
-- table is reachable by a user only when a migration grants it.
-- (The SDK's own schemas here; user space's had theirs revoked at boot,
-- by Database.ensureRoles, before this ran — they are not the migrator's.)
do $$
declare s text;
begin
  for s in select nspname from pg_namespace where nspowner = (select oid from pg_roles where rolname = current_user) loop
    execute format('revoke all on all tables in schema %I from authenticated', s);
    execute format('revoke all on all sequences in schema %I from authenticated', s);
  end loop;
end $$;
grant select, insert, update, delete on
  phantom_agent_sdk.projects, phantom_agent_sdk.workspaces, phantom_agent_sdk.sessions, phantom_agent_sdk.cards,
  phantom_agent_sdk.card_revisions, phantom_agent_sdk.crons, phantom_agent_sdk.background_tasks, phantom_agent_sdk.media,
  phantom_agent_sdk.token_usage, phantom_agent_sdk.settings
  to authenticated;
grant usage, select on all sequences in schema phantom_agent_sdk to authenticated;
grant select on identity."user", identity.organization, identity.member to authenticated;

-- ── the SDK's old schema name ───────────────────────────────────────────
-- Migrations 001–053 were written in phantom_looper, the schema the SDK grew
-- in; 054 moved every table out. On a fresh database that leaves it behind,
-- empty and the migrator's — and user space (whose name it now is) could
-- not create its tables in it. Gone when it is ours and empty; an install
-- whose app already owns it is left alone.
do $$
begin
  if exists (select from pg_namespace n where n.nspname = 'phantom_looper'
               and n.nspowner = (select oid from pg_roles where rolname = current_user)
               and not exists (select from pg_class c where c.relnamespace = n.oid)
               and not exists (select from pg_proc p where p.pronamespace = n.oid)) then
    drop schema phantom_looper;
  end if;
end $$;

-- ── columns the app's first two migrations moved out ────────────────────
-- phantom-looper's 001/002 copied these into its own tables and dropped
-- them here. An app's migrations no longer alter SDK tables, so the SDK
-- drops them itself (a no-op where they are already gone).
alter table phantom_agent_sdk.telegram_bot_state
  drop column if exists mode, drop column if exists active_session_id, drop column if exists active_project_id;
alter table phantom_agent_sdk.cards drop column if exists auto_plan, drop column if exists auto_build;
