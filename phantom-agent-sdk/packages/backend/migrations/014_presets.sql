-- Provider presets: named snapshots of the model settings (provider/model/
-- base_url for each agent, reasoning, max_steps). Applying one writes the
-- values into the global settings layer; absent keys are cleared so the
-- cascade takes over.
create table phantom_looper.presets (
  id text primary key,
  name text not null unique,
  values jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
