-- A session has an agent TYPE (`agent`: the registered type it runs — never
-- null, never "who drove it") and a fact about who opened it
-- (`started_by`: person, looper, cron, telegram). Until now `agent` carried
-- both: null meant a person's coding session, 'coding' a looper-run one,
-- 'cron' a cron's. The seat no longer changes hands.
alter table phantom_looper.sessions add column started_by text not null default 'person';
update phantom_looper.sessions set started_by = 'looper' where agent in ('coding', 'supervisor');
update phantom_looper.sessions set started_by = 'cron' where agent = 'cron';
update phantom_looper.sessions set agent = 'coding' where agent is null or agent = 'cron';
alter table phantom_looper.sessions alter column agent set not null;
