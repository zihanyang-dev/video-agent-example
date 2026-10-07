-- migrate:up
-- Bound the published-row candidate window without scanning retained JSON.
-- Run status is checked by the deletion, not assumed from publication alone.
CREATE INDEX event_outbox_retention_idx
  ON execution.event_outbox (published_at, event_id)
  WHERE published_at IS NOT NULL;

-- migrate:down
DROP INDEX execution.event_outbox_retention_idx;
