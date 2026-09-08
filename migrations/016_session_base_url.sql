-- The endpoint the session's model is called at, pinned beside provider/model.
-- A provider and a model name do not say WHERE to send the request: without
-- this a session pinned to one provider inherited whatever endpoint the global
-- settings held, which is the wrong server. The three travel together.
alter table phantom_looper.sessions add column base_url text;
