-- The looper's two per-card switches leave the SDK's cards table for a table
-- of the app's own (docs/v1-plan.md §1, the schema split's last move). As
-- with 001, installs from before SDK 059 also copied the switches out here
-- and dropped the SDK's columns; SDK 059 drops them now, and a fresh install
-- has nothing to copy. A card with no row reads null for both, through the
-- SDK's CardFieldsExtension door.

create table phantom_looper.card_automation (
  card_id     bigint primary key references phantom_agent_sdk.cards(id) on delete cascade,
  auto_plan   boolean,
  auto_build  boolean
);
