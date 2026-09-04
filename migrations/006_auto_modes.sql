-- The looper's one switch becomes two, one per loop column: supervisor_enabled
-- -> auto_plan (gates `plan`) + auto_build (gates `in_progress`). The old
-- switch meant both, so every stored row — global and workspace:<id> alike —
-- seeds BOTH new keys with its value: nobody's running loop changes behavior.
-- No auto_plan/auto_build row can predate this — unknown keys were always
-- refused — so the inserts cannot collide.
insert into phantom_looper.settings (scope, key, value, secret)
select scope, k.key, value, false
  from phantom_looper.settings
 cross join (values ('auto_plan'), ('auto_build')) as k(key)
 where phantom_looper.settings.key = 'supervisor_enabled';

delete from phantom_looper.settings where key = 'supervisor_enabled';
