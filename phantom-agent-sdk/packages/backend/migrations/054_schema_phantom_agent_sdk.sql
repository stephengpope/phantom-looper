-- The schema split (docs/v1-plan.md §1). The SDK's tables take the SDK's own
-- schema, phantom_agent_sdk; phantom_looper is the app's from here on (its
-- own migrations folder and ledger — PhantomBackendConfig.migrations). A pure
-- move: `set schema` carries each table's indexes, constraints, sequences
-- and triggers with it; nothing is renamed, no row changes.
--
-- The SDK's migration ledger moves too (public.schema_migrations →
-- phantom_agent_sdk.schema_migrations) — in code, before this file runs,
-- because the ledger must be read to know this file is due
-- (Database.migrate, MigrationSet.ledgerMovedFrom).

create schema if not exists phantom_agent_sdk;

alter table phantom_looper.settings                 set schema phantom_agent_sdk;
alter table phantom_looper.projects                 set schema phantom_agent_sdk;
alter table phantom_looper.cards                    set schema phantom_agent_sdk;
alter table phantom_looper.card_revisions           set schema phantom_agent_sdk;
alter table phantom_looper.workspaces               set schema phantom_agent_sdk;
alter table phantom_looper.sessions                 set schema phantom_agent_sdk;
alter table phantom_looper.telegram_bot_state       set schema phantom_agent_sdk;
alter table phantom_looper.telegram_sent_messages   set schema phantom_agent_sdk;
alter table phantom_looper.telegram_handled_updates set schema phantom_agent_sdk;
alter table phantom_looper.background_tasks         set schema phantom_agent_sdk;
alter table phantom_looper.presets                  set schema phantom_agent_sdk;
alter table phantom_looper.log_tokens               set schema phantom_agent_sdk;
alter table phantom_looper.crons                    set schema phantom_agent_sdk;

-- The revision trigger's function: moved (the trigger holds it by oid, so
-- the trigger follows), then its body rewritten — it names the revisions
-- table outright.
alter function phantom_looper.record_card_revision() set schema phantom_agent_sdk;
create or replace function phantom_agent_sdk.record_card_revision() returns trigger
language plpgsql
as $fn$
declare diff jsonb;
begin
  -- updated_at moves on every write; recording it would make every revision
  -- claim two changes.
  select jsonb_object_agg(e.key, e.value) into diff
    from jsonb_each(to_jsonb(old) - 'updated_at') e
    where to_jsonb(new) -> e.key is distinct from e.value;
  if diff is not null then
    insert into phantom_agent_sdk.card_revisions (card_id, changed_from) values (old.id, diff);
  end if;
  return new;
end
$fn$;
