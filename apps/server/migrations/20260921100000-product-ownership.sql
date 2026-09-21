create schema product;
alter table public.threads set schema product;
alter table public.messages set schema product;
alter table product.threads add column revision bigint not null default 0;
alter table product.threads add column active_turn_id text;

update product.messages set body = case
  when body->>'role' = 'activity' then jsonb_build_object(
    'id', message_id, 'kind', 'activity',
    'activity', (body->'content') || jsonb_build_object('kind', body->>'activityType'))
  else jsonb_build_object('id', message_id, 'kind', 'text', 'author', body->>'role',
    'text', coalesce(body->>'content', ''), 'finished', true)
end;

create table product.outbox (
  seq bigserial primary key,
  command_id text not null unique,
  body jsonb not null,
  delivered boolean not null default false
);
create table product.execution_receipts (
  event_id text primary key,
  thread_id text not null,
  sequence bigint not null,
  unique (thread_id, sequence)
);
create table product.execution_views (
  thread_id text primary key,
  sequence bigint not null default 0
);
create table product.events (
  thread_id text not null references product.threads on delete cascade,
  cursor bigint not null,
  body jsonb not null,
  primary key (thread_id, cursor)
);

do $$ begin
  if not exists (select from pg_roles where rolname = 'vid_product') then
    create role vid_product nologin;
  end if;
end $$;
grant usage on schema product to vid_product;
grant select, insert, update, delete on all tables in schema product to vid_product;
grant usage, select on all sequences in schema product to vid_product;
