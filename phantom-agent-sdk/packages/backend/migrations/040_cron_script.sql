-- A cron that runs a SCRIPT instead of a prompt.
--
-- A prompt run is an agent turn: system prompt, tools, model calls — tokens
-- on every fire. A script run is `sh <path>` in the session's container,
-- no model at all: for the nightly backup, the report, the health check —
-- anything a shell script already does. Same schedule, same session as the
-- record, same sync of any files it changes; only the body differs.
--
-- Exactly one of `prompt` / `script` is set — the check says so, Crons
-- (crons.ts) enforces it in words the agent can act on. `script` is a path
-- inside the checkout.
alter table phantom_looper.crons
  alter column prompt drop not null,
  add column script text,
  add constraint crons_prompt_or_script check (num_nonnulls(prompt, script) = 1);
