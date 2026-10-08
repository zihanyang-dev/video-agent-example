-- migrate:up
-- Stop the old, unlocked worker before applying this replacement. Legacy private
-- data remains available for an explicit offline import; it is never replayed
-- through the new engine during ordinary request admission.
ALTER TABLE execution.conversations RENAME COLUMN history TO legacy_history;
ALTER TABLE execution.conversations
  ADD COLUMN harness_engine text CHECK (harness_engine IN ('pi', 'openai')),
  ADD COLUMN native_session_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN legacy_import_required boolean NOT NULL DEFAULT false,
  ADD COLUMN workspace_reset_required boolean NOT NULL DEFAULT false,
  ADD COLUMN workspace_transition_pending boolean NOT NULL DEFAULT false;
UPDATE execution.conversations
SET harness_engine = 'pi',
    legacy_import_required = legacy_history NOT IN ('[]'::jsonb, 'null'::jsonb)
      OR active_run_id IS NOT NULL,
    sandbox_recovery_required = sandbox_recovery_required OR active_run_id IS NOT NULL;

-- Reservations precede actual requests. Unknown attempts consume allowances;
-- neither a new owner nor a native continuation refunds or resets them.
ALTER TABLE execution.runs
  ADD COLUMN model_call_count integer NOT NULL DEFAULT 0 CHECK (model_call_count BETWEEN 0 AND 16),
  ADD COLUMN uncheckpointed_effects integer NOT NULL DEFAULT 0 CHECK (uncheckpointed_effects >= 0),
  ADD COLUMN resume_count integer NOT NULL DEFAULT 0 CHECK (resume_count BETWEEN 0 AND 2),
  ADD COLUMN deadline_at timestamptz;

-- migrate:down
-- Downgrade cannot safely reinterpret newly persisted native state as legacy
-- history. Preserve private data and fail closed instead of discarding it.
DO $$ BEGIN RAISE EXCEPTION 'Native session replacement requires explicit offline rollback'; END $$;
