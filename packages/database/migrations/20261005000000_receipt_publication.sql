-- migrate:up
-- The existing receipt ledger remains the only publication state. These indexes
-- make identity, terminal and committed-prefix lookups independent of history size.
-- Reject inconsistent retained terminals rather than silently choosing a winner.
CREATE UNIQUE INDEX execution_events_run_terminal_idx
  ON product.execution_events (run_id)
  WHERE payload ->> 'kind' IN ('run-completed', 'run-cancelled', 'run-failed');

CREATE INDEX execution_events_run_message_idx
  ON product.execution_events (run_id, ordinal)
  WHERE payload ? 'messageID';

CREATE INDEX execution_events_run_processed_idx
  ON product.execution_events (run_id, ordinal DESC)
  WHERE processed;

-- migrate:down
DROP INDEX product.execution_events_run_processed_idx;
DROP INDEX product.execution_events_run_message_idx;
DROP INDEX product.execution_events_run_terminal_idx;
