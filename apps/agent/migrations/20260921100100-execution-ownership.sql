create schema execution;
alter table public.sessions drop constraint sessions_thread_id_fkey;
alter table public.sessions set schema execution;
alter table execution.sessions add column workspace text;
update execution.sessions set workspace = 'threads/' || thread_id || '/';
alter table execution.sessions add column active_turn_id text;
alter table execution.sessions add column event_sequence bigint not null default 0;

create table execution.inputs (
  command_id text primary key,
  thread_id text not null references execution.sessions,
  ordinal bigserial not null,
  message text not null,
  turn_id text,
  delivered boolean not null default false
);
create index pending_inputs on execution.inputs (thread_id, ordinal) where turn_id is null;
create table execution.runs (
  turn_id text primary key,
  thread_id text not null references execution.sessions,
  owner text not null,
  state text not null check (state in ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  accepting boolean not null default true,
  cancelled boolean not null default false,
  lease_until timestamptz not null,
  sequence bigint not null default 0
);
create table execution.stops (command_id text primary key);
create table execution.outbox (
  seq bigserial primary key,
  event_id text not null unique,
  body jsonb not null,
  delivered boolean not null default false
);

do $$ begin
  if not exists (select from pg_roles where rolname = 'vid_execution') then
    create role vid_execution nologin;
  end if;
end $$;
grant usage on schema execution to vid_execution;
grant select, insert, update, delete on all tables in schema execution to vid_execution;
grant usage, select on all sequences in schema execution to vid_execution;
