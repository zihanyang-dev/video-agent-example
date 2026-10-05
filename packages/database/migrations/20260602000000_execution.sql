-- migrate:up
CREATE SCHEMA execution;

CREATE TYPE execution.run_status AS ENUM ('queued', 'running', 'completed', 'cancelled', 'failed');

-- Commands are retained after execution: command IDs and canonical JSON are replay authority.
-- There are deliberately no references to product tables; execution accepts server commands,
-- not browser history, and needs no permission to read product records.
CREATE TABLE execution.command_inbox (
  command_id uuid PRIMARY KEY,
  thread_id uuid NOT NULL,
  run_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('start', 'cancel')),
  command jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX command_inbox_run_kind_idx ON execution.command_inbox (run_id, kind);

CREATE TABLE execution.conversations (
  thread_id uuid PRIMARY KEY,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  active_run_id uuid,
  lease_owner text,
  lease_until timestamptz,
  fence integer NOT NULL DEFAULT 0 CHECK (fence >= 0),
  CHECK ((active_run_id IS NULL AND lease_owner IS NULL AND lease_until IS NULL)
    OR (active_run_id IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);

CREATE TABLE execution.runs (
  run_id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES execution.conversations (thread_id),
  command_id uuid NOT NULL UNIQUE REFERENCES execution.command_inbox (command_id),
  message_id uuid NOT NULL,
  text text NOT NULL,
  assistant_message_id uuid,
  status execution.run_status NOT NULL DEFAULT 'queued',
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runs_thread_status_idx ON execution.runs (thread_id, status, created_at);

-- Published events are retained for stable replay; publication is not downstream acceptance.
CREATE TABLE execution.event_outbox (
  event_id uuid PRIMARY KEY,
  thread_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES execution.runs (run_id),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (run_id, ordinal)
);

-- migrate:down
DROP TABLE execution.event_outbox;
DROP TABLE execution.runs;
DROP TABLE execution.conversations;
DROP TABLE execution.command_inbox;
DROP TYPE execution.run_status;
DROP SCHEMA execution;
