-- Track which sessions have been reported in the idle digest notification.
-- A session is eligible when it finished (unlocked, transcript updated) and
-- has not been digested since that activity.
alter table phantom_looper.sessions
  add column digest_notified_at timestamp with time zone;
