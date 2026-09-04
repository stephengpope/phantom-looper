-- One session, one transcript. The looper used to store its supervisor
-- conversation as a SECOND transcript on the card's session (keyed by an
-- `agent` column). That violated the design: everything is a session, and a
-- session holds exactly one conversation. This migration gives every
-- supervisor conversation a session of its own and removes the agent
-- dimension from transcripts.
--
--   before: session S (agent='supervisor', card=N)
--             transcripts (S,'coding')      — the work
--             transcripts (S,'supervisor')  — the rounds
--   after:  session S (agent='coding', card=N)     ← the coder, one transcript
--           session S' (agent='supervisor', card=N) ← the rounds, one transcript
--
-- S' has no checkout — it is a conversation-only session; its id is derived
-- deterministically from S so a re-run cannot double-split.

-- 1 — a new session per supervisor conversation, carrying the original's
-- workspace, branch, claim and card. created_at copies the original so the
-- looper's newest-session seating keeps its clock.
insert into phantom_looper.sessions
  (id, workspace_id, branch, claim_sha, status, agent, card, created_at, last_used_at)
select lower(substr(md5('sup:' || s.id), 1, 26)),
       s.workspace_id, s.branch, s.claim_sha, s.status, 'supervisor', s.card,
       s.created_at, s.last_used_at
from phantom_looper.transcripts t
join phantom_looper.sessions s on s.id = t.session_id
where t.agent = 'supervisor'
on conflict (id) do nothing;

-- 2 — move the supervisor conversations onto their new sessions.
update phantom_looper.transcripts t
set session_id = lower(substr(md5('sup:' || t.session_id), 1, 26))
where t.agent = 'supervisor';

-- 3 — the original card sessions are the CODER's sessions now. The rows to
-- keep as 'supervisor' are exactly the derived ids step 1 minted; everything
-- else stamped 'supervisor' is an original.
update phantom_looper.sessions s
set agent = 'coding'
where s.agent = 'supervisor'
  and s.id not in (
    select lower(substr(md5('sup:' || o.id), 1, 26)) from phantom_looper.sessions o
  );

-- 4 — one transcript per session: drop the agent dimension.
alter table phantom_looper.transcripts drop constraint transcripts_pkey;
alter table phantom_looper.transcripts drop column agent;
alter table phantom_looper.transcripts add primary key (session_id);
