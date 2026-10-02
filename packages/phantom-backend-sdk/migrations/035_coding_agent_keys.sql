-- The coding agent's settings get the prefix the other two agents already
-- have: provider/model/base_url/reasoning/max_steps and the five compaction
-- keys become coding_*. Stored rows (every layer) and the keys inside saved
-- presets carry over. No coding_* row can predate this — unknown keys were
-- always refused — so the rename cannot collide.
update phantom_looper.settings
   set key = 'coding_' || key
 where namespace = 'general'
   and key in ('provider', 'model', 'base_url', 'reasoning', 'max_steps',
               'context_window', 'compact_threshold_pct', 'compact_strategy',
               'compact_summarize_pct', 'compact_max_tokens');

update phantom_looper.presets
   set values = (
     select coalesce(jsonb_object_agg(
       case when e.key in ('provider', 'model', 'base_url', 'reasoning', 'max_steps')
            then 'coding_' || e.key else e.key end, e.value), '{}'::jsonb)
       from jsonb_each(values) e)
 where values ?| array['provider', 'model', 'base_url', 'reasoning', 'max_steps'];
