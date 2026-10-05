-- migrate:up
-- The conversation lease serializes this pointer; completion commits it with history and terminal outbox.
ALTER TABLE execution.conversations ADD COLUMN workspace_checkpoint jsonb;

-- migrate:down
ALTER TABLE execution.conversations DROP COLUMN workspace_checkpoint;
