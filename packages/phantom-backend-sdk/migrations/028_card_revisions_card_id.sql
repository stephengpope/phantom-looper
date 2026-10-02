-- A card's history links to the card by its key.
--
-- card_revisions pointed at cards by (workspace_id, card_number) — the handle
-- people use, not the key a foreign key is for (the rule set in 027). Now
-- `card_id references cards(id) on delete cascade`: history lives and dies
-- with its card. The one thing that gave up is the 'delete' revision — a row
-- recording a card that no longer exists has no key to point at, and nothing
-- read it (the board addresses live cards). The trigger records updates only.
--
-- Revisions of cards already deleted cannot be linked and go.

alter table phantom_looper.card_revisions
  add column card_id bigint references phantom_looper.cards(id) on delete cascade;

update phantom_looper.card_revisions r
   set card_id = c.id
  from phantom_looper.cards c
 where c.workspace_id = r.workspace_id and c.number = r.card_number;

delete from phantom_looper.card_revisions where card_id is null;

alter table phantom_looper.card_revisions
  alter column card_id set not null,
  drop column workspace_id,
  drop column card_number;

create index card_revisions_card_idx on phantom_looper.card_revisions (card_id);

-- An update stores the OLD values of just the keys that changed.
create or replace function phantom_looper.record_card_revision() returns trigger
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
    insert into phantom_looper.card_revisions (card_id, op, changed)
      values (old.id, 'update', diff);
  end if;
  return new;
end
$fn$;

drop trigger cards_revision on phantom_looper.cards;
create trigger cards_revision
  after update on phantom_looper.cards
  for each row execute function phantom_looper.record_card_revision();
