-- session_idle_destroy_ms is gone: disk pressure (disk_cleanup_percent,
-- default 80) is the ONE cleanup trigger now, and every deletion is preceded
-- by a backup push to the session's branch. Rows for the old key would sit
-- in the store forever, read by nothing.
delete from phantom_looper.settings where key = 'session_idle_destroy_ms' and namespace = 'general';
