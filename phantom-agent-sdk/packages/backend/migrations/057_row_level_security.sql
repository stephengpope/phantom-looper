-- Row-level security (docs/multi-user.md part 2, step 5): the fence Postgres
-- enforces when SQL is handed to something that is not the backend's own
-- code — Database.queryAs, which connects as `authenticated` and names the
-- caller in two transaction settings. A policy binds every role but the
-- table's owner and roles marked BYPASSRLS: `migrator` owns these tables,
-- `backend` carries BYPASSRLS (Database.ensureRoles — every SDK read and
-- write is as before), so only `authenticated` is fenced.
--
-- One policy per table, keyed on the organization. A table with RLS on and
-- no policy shows `authenticated` nothing: settings (credentials), presets,
-- log_tokens, background_tasks, telegram_*, and identity's session /
-- account / verification / apikey / invitation never cross.

-- Who is asking: the two settings queryAs sets for the transaction.
-- `security definer` so a policy's lookup through the project runs as the
-- function's owner (migrator) and is one indexed read, not a nested policy.
create or replace function phantom_agent_sdk.caller_organization() returns text
language sql stable as $$ select nullif(current_setting('phantom.organization_id', true), '') $$;
create or replace function phantom_agent_sdk.caller_user() returns text
language sql stable as $$ select nullif(current_setting('phantom.user_id', true), '') $$;
create or replace function phantom_agent_sdk.visible_project(project_id text) returns boolean
language sql stable security definer set search_path = phantom_agent_sdk as $$
  select exists (select from projects where id = project_id and organization_id = caller_organization())
$$;
-- Is the caller a member of this organization? Definer: a policy on
-- identity.member that read identity.member itself would recurse
-- ("infinite recursion detected in policy"); the owner's read is not fenced.
create or replace function phantom_agent_sdk.member_of(organization_id text) returns boolean
language sql stable security definer set search_path = phantom_agent_sdk as $$
  select exists (select from identity.member m where m.organization_id = member_of.organization_id and m.user_id = caller_user())
$$;

-- The root: a project is the caller's organization's.
alter table phantom_agent_sdk.projects enable row level security;
create policy by_organization on phantom_agent_sdk.projects
  using (organization_id = phantom_agent_sdk.caller_organization())
  with check (organization_id = phantom_agent_sdk.caller_organization());

-- Under a project: visible when the project is.
alter table phantom_agent_sdk.workspaces enable row level security;
create policy by_project on phantom_agent_sdk.workspaces
  using (phantom_agent_sdk.visible_project(project_id)) with check (phantom_agent_sdk.visible_project(project_id));
alter table phantom_agent_sdk.sessions enable row level security;
create policy by_project on phantom_agent_sdk.sessions
  using (phantom_agent_sdk.visible_project(project_id)) with check (phantom_agent_sdk.visible_project(project_id));
alter table phantom_agent_sdk.cards enable row level security;
create policy by_project on phantom_agent_sdk.cards
  using (phantom_agent_sdk.visible_project(project_id)) with check (phantom_agent_sdk.visible_project(project_id));
alter table phantom_agent_sdk.crons enable row level security;
create policy by_project on phantom_agent_sdk.crons
  using (phantom_agent_sdk.visible_project(project_id)) with check (phantom_agent_sdk.visible_project(project_id));
alter table phantom_agent_sdk.card_revisions enable row level security;
create policy by_card on phantom_agent_sdk.card_revisions
  using (exists (select from phantom_agent_sdk.cards c where c.id = card_id and phantom_agent_sdk.visible_project(c.project_id)));

-- Nothing: on, no policy.
alter table phantom_agent_sdk.settings enable row level security;
alter table phantom_agent_sdk.presets enable row level security;
alter table phantom_agent_sdk.log_tokens enable row level security;
alter table phantom_agent_sdk.background_tasks enable row level security;
alter table phantom_agent_sdk.telegram_bot_state enable row level security;
alter table phantom_agent_sdk.telegram_sent_messages enable row level security;
alter table phantom_agent_sdk.telegram_handled_updates enable row level security;
alter table phantom_agent_sdk.schema_migrations enable row level security;

-- Identity: the caller's own organizations, their members, themselves.
alter table identity.organization enable row level security;
create policy own on identity.organization using (phantom_agent_sdk.member_of(id));
alter table identity.member enable row level security;
create policy own_organizations on identity.member using (phantom_agent_sdk.member_of(organization_id));
alter table identity."user" enable row level security;
create policy self on identity."user" using (id = phantom_agent_sdk.caller_user());
alter table identity.session enable row level security;
alter table identity.account enable row level security;
alter table identity.verification enable row level security;
alter table identity.invitation enable row level security;
alter table identity.apikey enable row level security;
