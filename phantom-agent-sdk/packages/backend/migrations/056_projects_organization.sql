-- A project's organization (docs/multi-user.md part 2, steps 3 and 4). Null
-- is the phantom admin's — every project today, so no row changes. The
-- organization's settings layer rides in a project's chain through this
-- column (lib/scopes.ts scopeOf). An organization that owns projects cannot
-- be deleted (restrict; Identity refuses it first, by name): a project never
-- vanishes with it, and never changes hands unasked. Two organizations may register one repo:
-- the unique moves to (organization_id, owner, name), nulls not distinct
-- so the phantom admin's own stay unique among themselves.

alter table phantom_agent_sdk.projects
  add column organization_id text references identity.organization(id) on delete restrict;
create index projects_organization_id_idx on phantom_agent_sdk.projects (organization_id);

alter table phantom_agent_sdk.projects drop constraint projects_owner_name_key;
alter table phantom_agent_sdk.projects
  add constraint projects_organization_owner_name_key unique nulls not distinct (organization_id, owner, name);
