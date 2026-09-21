-- Sequence belongs to a conversation, not an individual run.
alter table execution.runs drop column sequence;
create unique index one_running_turn_per_thread on execution.runs (thread_id) where state = 'running';
