-- migrate:up
-- Receipts are public facts, not execution authority. Publication is contiguous per
-- run; replay cursors are allocated only while holding the owning thread lock.
CREATE SEQUENCE product.execution_event_replay_cursor;

CREATE TABLE product.execution_events (
  event_id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES product.threads (thread_id),
  run_id uuid NOT NULL,
  ordinal bigint NOT NULL CHECK (ordinal > 0),
  payload jsonb NOT NULL,
  processed boolean NOT NULL DEFAULT false,
  replay_cursor bigint UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, ordinal),
  CHECK (replay_cursor IS NULL OR processed)
);

CREATE INDEX execution_events_thread_replay_idx
  ON product.execution_events (thread_id, replay_cursor)
  WHERE replay_cursor IS NOT NULL;

-- migrate:down
DROP TABLE product.execution_events;
DROP SEQUENCE product.execution_event_replay_cursor;
