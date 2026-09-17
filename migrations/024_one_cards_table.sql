-- Cards move out of the per-workspace schemas ("wsp_<id>".cards, one copy per
-- workspace, each with its own migration history in workspace_schema_state)
-- into ONE table beside every other, addressed by workspace_id. One migration
-- system, one trigger, typed queries. Every card keeps its number, its
-- content and its revision history; ids are reassigned (they were only unique
-- within a workspace, and nothing stores one).
--
-- Card numbers were a per-schema sequence (column `seq`); now `number`, from
-- a per-workspace counter (workspaces.next_card_number) seeded from that sequence so a deleted card's
-- number is still never reused.

create table phantom_looper.cards (
  id             bigint generated always as identity primary key,
  workspace_id   text not null references phantom_looper.workspaces(id) on delete cascade,
  number         int not null,
  status         text not null default 'backlog',
  pos            real not null,
  title          text not null,
  details        text not null default '',
  requirements   jsonb not null default '[]'::jsonb,
  blocked_reason text,
  resolution     text,
  auto_plan      boolean,
  auto_build     boolean,
  pinned         boolean not null default false,
  archived       boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (workspace_id, number)
);
create index cards_board_idx on phantom_looper.cards (workspace_id, status) where not archived;

-- A card's history, by (workspace_id, card_number): the number is the card's
-- permanent handle, so a deleted card still answers. The old card_id column
-- is gone — ids are reassigned by this move and nothing looked a revision up
-- by one.
create table phantom_looper.card_revisions (
  id           bigint generated always as identity primary key,
  workspace_id text not null references phantom_looper.workspaces(id) on delete cascade,
  card_number  int not null,
  op           text not null,
  changed      jsonb not null,
  changed_at   timestamptz not null default now()
);
create index card_revisions_card_idx on phantom_looper.card_revisions (workspace_id, card_number);

-- Revision history is a trigger, not route code, so any write path is
-- recorded. An update stores the OLD values of just the keys that changed; a
-- delete stores the whole card as it last stood.
create or replace function phantom_looper.record_card_revision() returns trigger
language plpgsql
as $fn$
declare diff jsonb;
begin
  -- A workspace delete cascades to its cards AND its revisions: a card dying
  -- with its workspace has nothing left to record for.
  if not exists (select 1 from phantom_looper.workspaces where id = old.workspace_id) then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    insert into phantom_looper.card_revisions (workspace_id, card_number, op, changed)
      values (old.workspace_id, old.number, 'delete', to_jsonb(old));
    return old;
  end if;
  -- updated_at moves on every write; recording it would make every revision
  -- claim two changes.
  select jsonb_object_agg(e.key, e.value) into diff
    from jsonb_each(to_jsonb(old) - 'updated_at') e
    where to_jsonb(new) -> e.key is distinct from e.value;
  if diff is not null then
    insert into phantom_looper.card_revisions (workspace_id, card_number, op, changed)
      values (old.workspace_id, old.number, 'update', diff);
  end if;
  return new;
end
$fn$;

create trigger cards_revision
  after update or delete on phantom_looper.cards
  for each row execute function phantom_looper.record_card_revision();

alter table phantom_looper.workspaces add column next_card_number int not null default 1;

-- The move. Every workspace's private schema, if it exists: copy cards and
-- revisions in (explicit columns — a schema at an older version fails loudly
-- here and the whole migration rolls back rather than dropping data), seed
-- the number counter from its sequence, drop the schema.
do $$
declare
  w record;
  s record;
begin
  for w in select id, schema_name from phantom_looper.workspaces loop
    if not exists (select 1 from pg_namespace where nspname = w.schema_name) then
      continue;
    end if;
    if coalesce((select version from phantom_looper.workspace_schema_state where workspace_id = w.id), 0) <> 5 then
      raise exception 'workspace % schema % is not at version 5 — cannot move its cards', w.id, w.schema_name;
    end if;

    execute format($q$
      insert into phantom_looper.cards
        (workspace_id, number, status, pos, title, details, requirements, blocked_reason, resolution,
         auto_plan, auto_build, pinned, archived, created_at, updated_at)
      select %L, seq, status, pos, title, details, requirements, blocked_reason, resolution,
         auto_plan, auto_build, pinned, archived, created_at, updated_at
      from %I.cards order by id
    $q$, w.id, w.schema_name);

    execute format($q$
      insert into phantom_looper.card_revisions (workspace_id, card_number, op, changed, changed_at)
      select %L, seq, op, changed, changed_at from %I.card_revisions order by id
    $q$, w.id, w.schema_name);

    execute format('select last_value, is_called from %I.card_seq', w.schema_name) into s;
    update phantom_looper.workspaces
      set next_card_number = case when s.is_called then s.last_value + 1 else s.last_value end
      where id = w.id;

    execute format('drop schema %I cascade', w.schema_name);
  end loop;
end $$;

drop table phantom_looper.workspace_schema_state;
alter table phantom_looper.workspaces drop column schema_name;
