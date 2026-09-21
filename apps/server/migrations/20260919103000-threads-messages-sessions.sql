create table threads (
  thread_id  text        primary key,
  user_id    text        not null,
  created_at timestamptz not null default now()
);

-- What a person reads back. `seq` orders them because `created_at` collides: one turn
-- writes several messages inside the same millisecond, and a reload would shuffle them.
--
-- Keyed by (thread, message) rather than by message alone, so settling an activity is an
-- upsert on a key we already hold and one thread can never overwrite another's.
create table messages (
  thread_id  text        not null references threads (thread_id) on delete cascade,
  message_id text        not null,
  seq        bigserial   not null,
  body       jsonb       not null,
  created_at timestamptz not null default now(),
  primary key (thread_id, message_id)
);

create index messages_by_thread on messages (thread_id, seq);

-- What the model is shown on the next turn. One row per thread, replaced whole: the harness
-- hands back its entire history and we do not interpret it, so there is nothing to append.
create table sessions (
  thread_id  text        primary key references threads (thread_id) on delete cascade,
  entries    jsonb       not null,
  updated_at timestamptz not null default now()
);
