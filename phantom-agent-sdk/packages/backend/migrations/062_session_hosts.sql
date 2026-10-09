-- Session hosts: boxes that run workspaces for this server (host/SessionHosts.ts).
-- A host connects OUT to the API with a key; the key makes it shared (the
-- server key: owner_user_id null, any workspace may land there) or personal
-- (a user's key: only that user's workspaces). Read and written as the backend
-- itself — RLS on, no policy: `authenticated` never reaches the rows directly.
--
-- boot: the host process's id, fresh per process — a reconnect carries the
-- same one, a restart a new one (its jobs in flight are gone).
-- facts: what the box reported at hello (docker version, arch, whether it can
-- hold a container to container_disk_gb).

create table phantom_agent_sdk.session_hosts (
  id            text primary key,
  name          text not null,
  owner_user_id text references identity."user"(id) on delete cascade,
  boot          text,
  facts         jsonb not null default '{}'::jsonb,
  connected_at  timestamptz,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index session_hosts_owner_user_id_idx on phantom_agent_sdk.session_hosts (owner_user_id);
alter table phantom_agent_sdk.session_hosts enable row level security;

-- Where a workspace's files and container are: the host it was placed on,
-- null for the built-in host (this server). Set once at creation, rewritten
-- only by a move. A deleted host leaves its workspaces pointing at nothing,
-- which reads as the built-in host — the files are gone with the box.
alter table phantom_agent_sdk.workspaces
  add column session_host_id text references phantom_agent_sdk.session_hosts(id) on delete set null;
create index workspaces_session_host_id_idx on phantom_agent_sdk.workspaces (session_host_id);
