-- migrate:up
-- This is operational evidence, not native history or engine allocation. The
-- native adapters checkpoint durably before reserving any model dispatch.
ALTER TABLE execution.conversations
  ADD COLUMN native_state_initialized boolean NOT NULL DEFAULT false;
UPDATE execution.conversations c
SET native_state_initialized = true
WHERE NOT c.legacy_import_required
  AND c.harness_engine IN ('pi', 'openai')
  AND EXISTS (
    SELECT 1 FROM execution.runs r
    WHERE r.thread_id = c.thread_id AND r.model_call_count > 0
  );

-- migrate:down
-- Dropping this evidence could reopen a lost initialized identity as empty.
DO $$ BEGIN RAISE EXCEPTION 'Native state evidence requires explicit offline rollback'; END $$;
