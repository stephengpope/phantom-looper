-- A runner is any box that connects out and takes jobs: a SESSION runner runs
-- workspaces, a CLIENT runner runs turns (host/Runners.ts). The table and
-- the workspace's pin take the one word; what a runner runs is in its facts.
alter table phantom_agent_sdk.session_runners rename to runners;
alter index phantom_agent_sdk.session_runners_owner_user_id_idx rename to runners_owner_user_id_idx;
alter table phantom_agent_sdk.workspaces rename column session_runner_id to runner_id;
alter index phantom_agent_sdk.workspaces_session_runner_id_idx rename to workspaces_runner_id_idx;
