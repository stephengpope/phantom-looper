-- Session hosts are session runners: the one word for a box that connects out
-- and runs workspaces (host/SessionRunners.ts). The table, the pin on a
-- workspace and their indexes take the name; nothing else changes.
alter table phantom_agent_sdk.session_hosts rename to session_runners;
alter index phantom_agent_sdk.session_hosts_owner_user_id_idx rename to session_runners_owner_user_id_idx;
alter table phantom_agent_sdk.workspaces rename column session_host_id to session_runner_id;
alter index phantom_agent_sdk.workspaces_session_host_id_idx rename to workspaces_session_runner_id_idx;
