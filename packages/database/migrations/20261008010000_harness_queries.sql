-- migrate:up
-- Run with workers stopped: these ordinary builds take table locks. Selection
-- keeps its existing FIFO and source-validation rules; only access paths change.
CREATE INDEX conversations_pending_harness_idx
  ON execution.conversations(thread_id)
  WHERE active_run_id IS NULL AND requested_engine IS NOT NULL;
CREATE INDEX runs_native_session_order_idx
  ON execution.runs(thread_id, native_session_id, created_at DESC, run_id DESC);

-- Extend the existing FIFO index instead of retaining two overlapping indexes.
CREATE INDEX runs_thread_status_order_idx
  ON execution.runs(thread_id, status, created_at, run_id);
DROP INDEX execution.runs_thread_status_idx;

-- migrate:down
CREATE INDEX runs_thread_status_idx ON execution.runs(thread_id, status, created_at);
DROP INDEX execution.runs_thread_status_order_idx;
DROP INDEX execution.runs_native_session_order_idx;
DROP INDEX execution.conversations_pending_harness_idx;
