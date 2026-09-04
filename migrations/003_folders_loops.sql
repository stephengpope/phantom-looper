-- Folders and loops: the structural split.
--
--   sessions = conversations (transcript, lock, who drives it)
--   folders  = checkouts (branch, claim; the directory on disk, named by id)
--   loops    = the pairing (this card, this coder, this supervisor) — written
--              once when a card enters the loop, immutable, the permanent
--              record of who reviewed what
--
-- A folder takes the SAME id as the session that owns it, so every directory,
-- container, and git path keeps its name. A supervisor session points its
-- folder_id at its coder's folder — the fake branch fields it used to carry
-- die here. The coder/supervisor pairing stops being a newest-per-card
-- assumption: the loop row states it.

create table phantom_looper.folders (
  id           text primary key,
  workspace_id text not null references phantom_looper.workspaces(id) on delete restrict,
  branch       text not null,
  claim_sha    text not null,
  created_at   timestamptz not null default now()
);

-- One folder per file-owning session, same id — directories keep their names.
insert into phantom_looper.folders (id, workspace_id, branch, claim_sha, created_at)
select id, workspace_id, branch, claim_sha, created_at
from phantom_looper.sessions
where agent is distinct from 'supervisor';

alter table phantom_looper.sessions
  add column folder_id text references phantom_looper.folders(id);

update phantom_looper.sessions set folder_id = id
where agent is distinct from 'supervisor';

-- Supervisors point at their coder's folder. The newest-per-card guess is
-- used here one FINAL time — to reconstruct history — then never again.
update phantom_looper.sessions sup set folder_id = (
  select c.id from phantom_looper.sessions c
  where c.workspace_id = sup.workspace_id and c.card = sup.card
    and c.agent = 'coding' and c.created_at <= sup.created_at
  order by c.created_at desc limit 1)
where sup.agent = 'supervisor';

create table phantom_looper.loops (
  id                    text primary key,
  workspace_id          text not null references phantom_looper.workspaces(id) on delete restrict,
  card                  int not null,
  coding_session_id     text not null references phantom_looper.sessions(id) on delete cascade,
  supervisor_session_id text not null references phantom_looper.sessions(id) on delete cascade,
  created_at            timestamptz not null default now()
);
create index loops_card_idx on phantom_looper.loops (workspace_id, card);

-- Synthesize loop rows for the existing pairs (coder's folder = its own id).
insert into phantom_looper.loops (id, workspace_id, card, coding_session_id, supervisor_session_id, created_at)
select lower(substr(md5('loop:' || sup.id), 1, 26)), sup.workspace_id, sup.card,
       sup.folder_id, sup.id, sup.created_at
from phantom_looper.sessions sup
where sup.agent = 'supervisor' and sup.card is not null and sup.folder_id is not null;

-- The facts have moved: branch/claim live on folders, the card pairing on
-- loops. Sessions stop carrying them — and stop being able to lie.
alter table phantom_looper.sessions drop column branch;
alter table phantom_looper.sessions drop column claim_sha;
alter table phantom_looper.sessions drop column card;
