-- The model and provider that drive a session, extracted from the transcript
-- header at each save. Rides the session list so every row says what model
-- the conversation used — no blob parsing on read.
alter table phantom_looper.sessions add column provider text;
alter table phantom_looper.sessions add column model text;
