-- `op` had one value. Since 028 the trigger records updates only (a deleted
-- card takes its history with it), so every row said 'update' and the
-- column told a reader nothing. A revision is: which card, the keys that
-- changed and what they changed FROM, when. `changed` read as the new
-- values; `changed_from` says what the row holds.
alter table phantom_looper.card_revisions drop column op;
alter table phantom_looper.card_revisions rename column changed to changed_from;

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
    insert into phantom_looper.card_revisions (card_id, changed_from) values (old.id, diff);
  end if;
  return new;
end
$fn$;
