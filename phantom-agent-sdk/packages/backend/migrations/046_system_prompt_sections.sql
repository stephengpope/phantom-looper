-- The system prompt is stored as its three sections — {stable, context,
-- volatile} — the shape the client SDK sends per turn (one system block
-- each, one cache mark each). Rows written before this held the coding
-- prompt's two pieces {base, workspace}: base was the stable text, workspace
-- the per-repo text, and nothing in the third place. Renamed in place: an
-- old session keeps its exact words.
update phantom_looper.sessions
set system_prompt = jsonb_build_object(
  'stable',   coalesce(system_prompt->>'base', ''),
  'context',  coalesce(system_prompt->>'workspace', ''),
  'volatile', '')
where system_prompt is not null and system_prompt ? 'base';
