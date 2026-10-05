-- Rename agent_database_in_code → agent_database_shared.
update phantom_looper.settings
   set key = 'agent_database_shared'
 where namespace = 'general'
   and key = 'agent_database_in_code';
