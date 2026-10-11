-- A media row exists only once its bytes are in and checked (media/Media.ts):
-- an upload the browser never finished leaves no row, its bytes the bucket's
-- to expire. The rows of unfinished uploads go with the columns that held
-- their state.
delete from phantom_agent_sdk.media where status = 'uploading';
drop index if exists phantom_agent_sdk.media_uploading_idx;
alter table phantom_agent_sdk.media drop column status, drop column upload_id;
