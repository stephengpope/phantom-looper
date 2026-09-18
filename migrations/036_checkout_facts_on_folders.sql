-- Checkout facts live on the checkout.
--
-- A folder is a checkout: the files on disk, the branch, the container. A
-- session is a conversation that uses one folder (sessions.folder_id): a coder
-- its own, a supervisor its coder's, the assistant the on-screen session's.
-- Four facts about the CHECKOUT sat on the conversation:
--
--   status        active / destroyed — whether the FILES exist ("destroy"
--                 deletes the files; the row stays for a restart)
--   last_used_at  when the checkout was last touched — what container
--                 reaping, the idle backup, the pressure sweep and the list's
--                 recency all read
--   last_push_at  when its branch last reached origin
--   work          its git state (not_pushed / not_merged / merged)
--
-- On the session, a supervisor's or the assistant's activity did not count
-- for the coder's container; it only worked because those clients sent the
-- coder's id instead of their own. Here they move to folders; every session
-- read joins them back in, so the API is unchanged.
--
-- Carry-over: on_disk from the owning session's status (the session sharing
-- the folder's id); last_used_at is the newest touch of ANY session on the
-- folder; the rest from the owner. A folder whose owner row is gone has no
-- files anyone can vouch for: on_disk false.

alter table phantom_looper.folders
  add column on_disk      boolean not null default true,
  add column last_used_at timestamptz not null default now(),
  add column last_push_at timestamptz,
  add column work         text;

update phantom_looper.folders f
   set on_disk      = coalesce((select s.status = 'active' from phantom_looper.sessions s where s.id = f.id), false),
       last_used_at = coalesce((select max(s.last_used_at) from phantom_looper.sessions s
                                 where s.folder_id = f.id or s.id = f.id), f.created_at),
       last_push_at = (select s.last_push_at from phantom_looper.sessions s where s.id = f.id),
       work         = (select s.work from phantom_looper.sessions s where s.id = f.id);

alter table phantom_looper.sessions
  drop column status,
  drop column last_used_at,
  drop column last_push_at,
  drop column work;
