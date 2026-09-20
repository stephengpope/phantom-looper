-- Secret names are UPPER_SNAKE — the env-var shape everyone types. The old
-- rule demanded lowercase and rejected MY_API_KEY outright; now the name is
-- uppercased on save and every read (core/secretName.ts). Rows saved under
-- the old rule are lifted to match, or the uppercased lookup would miss them.
-- No collisions possible: the old rule allowed only lowercase, so no scope
-- holds two names differing by case.
update phantom_looper.settings set key = upper(key) where namespace = 'secret';
