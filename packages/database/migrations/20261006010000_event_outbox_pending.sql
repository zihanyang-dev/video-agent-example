-- migrate:up
-- The relay polls unpublished rows every POLL_MS, while published rows are
-- retained indefinitely as investigation evidence. A partial index keeps the
-- pending scan bounded as the retained evidence grows.
CREATE INDEX event_outbox_pending_idx
  ON execution.event_outbox (run_id, ordinal)
  WHERE published_at IS NULL;

-- migrate:down
DROP INDEX execution.event_outbox_pending_idx;
