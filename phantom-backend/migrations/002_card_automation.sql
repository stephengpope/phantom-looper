-- The looper's two per-card switches leave the SDK's cards table for a table
-- of the app's own (docs/v1-plan.md §1, the schema split's last move). Same
-- shape as 001: the app's migration copies its fact out and drops the SDK's
-- columns, because the SDK's migrations run first every boot. Only cards
-- with a switch set get a row; a card with none reads null for both, as
-- before, through the SDK's CardFieldsExtension door.

create table phantom_looper.card_automation (
  card_id     bigint primary key references phantom_agent_sdk.cards(id) on delete cascade,
  auto_plan   boolean,
  auto_build  boolean
);

insert into phantom_looper.card_automation (card_id, auto_plan, auto_build)
  select id, auto_plan, auto_build from phantom_agent_sdk.cards
   where auto_plan is not null or auto_build is not null;

alter table phantom_agent_sdk.cards
  drop column auto_plan,
  drop column auto_build;
