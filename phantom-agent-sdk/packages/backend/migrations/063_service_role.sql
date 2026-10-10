-- The server's own principal has one name: service_role. The key that is
-- its credential (SERVICE_ROLE_KEY), the database role it runs as
-- (Database.ensureRoles renames `backend`), the console's login, and the
-- organization it owns when it makes something without naming anyone — the
-- row 059 called 'operator'.
--
-- The organization's id is referenced from every owned table: directly
-- (member, projects, media, …) and through the composite keys that tie a
-- child to its parent's organization (sessions → projects, …). None is
-- `on update cascade`, so the move is: every foreign key that carries the
-- id made deferrable, every check deferred to this transaction's commit,
-- a new row, every reference moved, the old row gone. All the DDL first:
-- Postgres refuses to alter a table with deferred checks pending on it.

-- ── the function the defaults call, and the trigger that calls it ───────
create or replace function phantom_agent_sdk.service_role_organization() returns text
language sql immutable as $$ select 'service_role'::text $$;

-- token_usage's owner trigger named the old function (059).
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
      new.organization_id := phantom_agent_sdk.service_role_organization();
    end if;
  end if;
  return new;
end
$fn$;

-- ── the DDL: defaults, and the foreign keys made deferrable ─────────────
do $$
declare r record;
begin
  -- Every organization_id column of ours whose default named the old function.
  for r in
    select table_schema as schema_name, table_name
      from information_schema.columns
     where column_name = 'organization_id' and column_default like '%operator_organization()%'
  loop
    execute format('alter table %I.%I alter column organization_id set default coalesce(phantom_agent_sdk.caller_organization(), phantom_agent_sdk.service_role_organization())',
      r.schema_name, r.table_name);
  end loop;
  -- Every foreign key one of whose columns is an organization id (a direct
  -- reference, or a composite that includes it). Left deferrable initially
  -- immediate — the same checks, at the same moments, from now on.
  for r in
    select n.nspname as schema_name, c.relname as table_name, k.conname
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where k.contype = 'f' and not k.condeferrable
       and exists (select from pg_attribute a where a.attrelid = c.oid and a.attnum = any (k.conkey) and a.attname = 'organization_id')
  loop
    execute format('alter table %I.%I alter constraint %I deferrable initially immediate', r.schema_name, r.table_name, r.conname);
  end loop;
end $$;

drop function phantom_agent_sdk.operator_organization();

-- ── the rows ────────────────────────────────────────────────────────────
insert into identity.organization (id, name, slug, created_at)
values ('service_role', 'Service role', 'service_role', now()) on conflict (id) do nothing;

do $$
declare r record;
begin
  set constraints all deferred;
  for r in
    select table_schema as schema_name, table_name
      from information_schema.columns
     where column_name = 'organization_id' and table_schema not in ('pg_catalog', 'information_schema')
       and is_generated = 'NEVER'
  loop
    execute format('update %I.%I set organization_id = %L where organization_id = %L', r.schema_name, r.table_name, 'service_role', 'operator');
  end loop;
  -- settings: organization_id is generated from the scope name (059).
  update phantom_agent_sdk.settings set scope = 'organization:service_role' where scope = 'organization:operator';
  delete from identity.organization where id = 'operator';
end $$;
