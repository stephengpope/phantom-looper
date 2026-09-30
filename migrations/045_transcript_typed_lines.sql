-- One record format. Every transcript line is typed —
--   {type:"message", id, at, message:{role, content}}
--   {type:"usage",   id, at, input, output, cacheRead, cacheWrite, ...}
--   {type:"interrupted", id, at}
-- — the format the client SDK reads and every writer writes from this
-- release on. Records written before this carried bare messages
-- ({role, content}) and usage lines with cache_read/cache_write; this
-- converts them once. A line that is not JSON is dropped (a torn write); the
-- retired {type:"session"} header line is dropped; line count recomputed.
create or replace function phantom_looper.transcript_typed(src text) returns text
language plpgsql as $$
declare
  raw text; j jsonb; out_lines text[] := '{}'; stamp text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  foreach raw in array string_to_array(src, E'\n') loop
    if btrim(raw) = '' then continue; end if;
    begin j := raw::jsonb; exception when others then continue; end;
    if jsonb_typeof(j) <> 'object' then continue; end if;
    if j ? 'role' and not (j ? 'type') then
      j := jsonb_build_object('type', 'message', 'id', gen_random_uuid()::text, 'at', stamp, 'message', j);
    elsif j->>'type' = 'usage' then
      j := (j - 'cache_read' - 'cache_write')
        || jsonb_build_object('cacheRead', coalesce((j->>'cache_read')::numeric, (j->>'cacheRead')::numeric, 0),
                              'cacheWrite', coalesce((j->>'cache_write')::numeric, (j->>'cacheWrite')::numeric, 0),
                              'input', coalesce((j->>'input')::numeric, 0), 'output', coalesce((j->>'output')::numeric, 0));
      if not (j ? 'id') then j := j || jsonb_build_object('id', gen_random_uuid()::text, 'at', stamp); end if;
    elsif j->>'type' = 'session' then
      continue;
    elsif j ? 'type' then
      if not (j ? 'id') then j := j || jsonb_build_object('id', gen_random_uuid()::text, 'at', stamp); end if;
    else
      continue;
    end if;
    out_lines := array_append(out_lines, j::text);
  end loop;
  if array_length(out_lines, 1) is null then return null; end if;
  return array_to_string(out_lines, E'\n') || E'\n';
end $$;

update phantom_looper.sessions
   set transcript = phantom_looper.transcript_typed(transcript)
 where transcript is not null;

update phantom_looper.sessions
   set transcript_lines = coalesce((
     select count(*) from unnest(string_to_array(transcript, E'\n')) as l where btrim(l) <> ''
   ), 0);

drop function phantom_looper.transcript_typed(text);
