-- card_automation is a card's own data, so a user reaches it exactly where
-- they reach the card: the policy joins the SDK's cards, whose own policy
-- decides (an app's policy on its table, over the SDK's — permissions.md).
alter table phantom_looper.card_automation enable row level security;
create policy by_card on phantom_looper.card_automation to authenticated
  using (exists (select from phantom_agent_sdk.cards c where c.id = card_id))
  with check (exists (select from phantom_agent_sdk.cards c where c.id = card_id));
grant select, insert, update, delete on phantom_looper.card_automation to authenticated;
