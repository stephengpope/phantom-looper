-- The card a session works on lives on the session.
--
-- It lived on `loops` — the looper's pairing row (this card, this coder, this
-- supervisor), written only when a round ran. So a session could be on a card
-- ONLY because the looper put it there, and the pairing carried a fact that
-- belongs to the session. Now `sessions.card_id` names the card, keyed to the
-- card's primary key (the number is the handle people and agents use; storage
-- links use the key). The coder and its supervisor both carry it.
--
-- The pairing itself is derived, not stored: a card's coder is its newest
-- coding session, its supervisor its newest supervisor session. `loops` is
-- dropped.
--
-- A loop row whose card no longer exists has no key to point at: those
-- sessions come out with card_id null.

alter table phantom_looper.sessions
  add column card_id bigint references phantom_looper.cards(id) on delete set null;

update phantom_looper.sessions s
   set card_id = c.id
  from phantom_looper.loops l
  join phantom_looper.cards c on c.workspace_id = l.workspace_id and c.number = l.card
 where s.id in (l.coding_session_id, l.supervisor_session_id);

create index sessions_card_idx on phantom_looper.sessions (card_id);

drop table phantom_looper.loops;
