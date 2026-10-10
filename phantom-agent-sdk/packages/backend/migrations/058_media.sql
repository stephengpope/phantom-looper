-- Media: tracked files on S3-compatible storage (media/Media.ts). The bytes
-- live in the bucket; this row is what an app joins on and what every
-- access is checked against. Each organization's files sit under its own
-- key prefix; `endpoint` + `bucket` say which storage holds the file, so an
-- organization that brings its own storage later does not lose the files
-- already written elsewhere.
--
-- organization_id: the owner and the fence; null = the phantom admin's.
-- user_id: the user it belongs to or was uploaded by — what that means for
-- access is user space's rule. project_id / session_id: the agent work that
-- made it, when an agent did.
--
-- status: 'uploading' until the bytes are in and checked (size, type), then
-- 'ready'. A row left 'uploading' is swept with its object and any
-- unfinished multipart upload (upload_id).

create table phantom_agent_sdk.media (
  id              text primary key,
  organization_id text references identity.organization(id) on delete restrict,
  user_id         text references identity."user"(id) on delete set null,
  project_id      text references phantom_agent_sdk.projects(id) on delete set null,
  session_id      text references phantom_agent_sdk.sessions(id) on delete set null,
  name            text not null,
  mime_type       text not null,
  size            bigint not null,
  status          text not null default 'uploading' check (status in ('uploading', 'ready')),
  endpoint        text not null,
  bucket          text not null,
  key             text not null,
  upload_id       text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index media_organization_id_idx on phantom_agent_sdk.media (organization_id);
create index media_project_id_idx on phantom_agent_sdk.media (project_id);
create index media_user_id_idx on phantom_agent_sdk.media (user_id);
create index media_uploading_idx on phantom_agent_sdk.media (created_at) where status = 'uploading';

-- The same fence as projects (057): `authenticated` sees its organization's rows.
alter table phantom_agent_sdk.media enable row level security;
create policy by_organization on phantom_agent_sdk.media
  using (organization_id = phantom_agent_sdk.caller_organization())
  with check (organization_id = phantom_agent_sdk.caller_organization());
