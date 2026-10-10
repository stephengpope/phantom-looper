-- A cron that names the model its runs use.
--
-- A run is a fresh coding session; by default it runs on what the workspace's
-- settings say at fire time. These three columns let one cron say otherwise —
-- the nightly report on a cheap model, the weekly audit on the strongest —
-- without moving the workspace's own setting. Null = the workspace's.
--
-- `provider` and `model` go together or not at all (a model id means nothing
-- without its provider; the pin rule in agentConfig.ts says the same). The
-- endpoint is not here: it is the provider's, and the run inherits the
-- workspace's when the provider matches. `reasoning` stands alone.
alter table phantom_looper.crons
  add column provider  text,
  add column model     text,
  add column reasoning text,
  add constraint crons_provider_and_model check (num_nonnulls(provider, model) in (0, 2));
