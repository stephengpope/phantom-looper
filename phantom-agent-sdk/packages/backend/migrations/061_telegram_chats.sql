-- Telegram for every user (docs/permissions.md): one bot per server, any
-- number of linked chats. A chat — a user's private chat with the bot, or a
-- group linked to one project — belongs to its user in its organization,
-- and everything said there runs as them. The operator's own chat stays the
-- `telegram_authorized_user` setting (the cli sets it), not a row here.
--
-- telegram_user_id: the Telegram account that linked it. Only that account
-- speaks for the user in the chat — in a group, other members are ignored.
-- project_id: set for a chat linked to one project; null for a private chat
-- that covers every project of its user.

create table phantom_agent_sdk.telegram_chats (
  id               text primary key,
  chat_id          bigint not null unique,
  telegram_user_id bigint not null,
  organization_id  text not null default coalesce(phantom_agent_sdk.caller_organization(), phantom_agent_sdk.operator_organization())
                   references identity.organization(id) on delete cascade,
  user_id          text default phantom_agent_sdk.caller_user() references identity."user"(id) on delete cascade,
  project_id       text,
  created_at       timestamptz not null default now(),
  foreign key (project_id, organization_id) references phantom_agent_sdk.projects (id, organization_id) on delete cascade
);
create index telegram_chats_organization_id_idx on phantom_agent_sdk.telegram_chats (organization_id);

-- A link in waiting: a one-time code a user's app shows as t.me/<bot>?start=<code>.
-- Whoever sends it to the bot within ten minutes links that chat.
create table phantom_agent_sdk.telegram_link_codes (
  code             text primary key,
  organization_id  text not null default coalesce(phantom_agent_sdk.caller_organization(), phantom_agent_sdk.operator_organization())
                   references identity.organization(id) on delete cascade,
  user_id          text default phantom_agent_sdk.caller_user() references identity."user"(id) on delete cascade,
  project_id       text,
  expires_at       timestamptz not null,
  foreign key (project_id, organization_id) references phantom_agent_sdk.projects (id, organization_id) on delete cascade
);

-- A user sees and manages their own links and codes, in their organization.
do $$
declare t text;
begin
  foreach t in array array['telegram_chats', 'telegram_link_codes'] loop
    execute format('alter table phantom_agent_sdk.%I enable row level security', t);
    execute format('create policy own on phantom_agent_sdk.%I to authenticated
      using (organization_id = (select phantom_agent_sdk.caller_organization()) and user_id is not distinct from (select phantom_agent_sdk.caller_user()))
      with check (organization_id = (select phantom_agent_sdk.caller_organization()) and user_id is not distinct from (select phantom_agent_sdk.caller_user()))', t);
    execute format('grant select, insert, update, delete on phantom_agent_sdk.%I to authenticated', t);
  end loop;
end $$;
