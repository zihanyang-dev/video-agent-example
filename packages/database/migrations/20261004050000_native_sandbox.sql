-- migrate:up
-- An opaque provider identity is not a VM fence. Uncertain ownership requires
-- operator confirmation before another run may connect to the same environment.
ALTER TABLE execution.conversations
  ADD COLUMN native_sandbox jsonb,
  ADD COLUMN sandbox_recovery_required boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT native_sandbox_reference CHECK (
    native_sandbox IS NULL OR (
      jsonb_typeof(native_sandbox) = 'object'
      AND native_sandbox ?& ARRAY['provider', 'id']
      AND jsonb_typeof(native_sandbox->'provider') = 'string'
      AND jsonb_typeof(native_sandbox->'id') = 'string'
      AND length(native_sandbox->>'provider') > 0
      AND length(native_sandbox->>'id') > 0
    )
  );
-- Legacy archives cannot be silently replaced by an empty native environment.
UPDATE execution.conversations SET sandbox_recovery_required = true
WHERE workspace_checkpoint IS NOT NULL;
-- Preserve the exact archive/digest for reviewed operator recovery, without
-- retaining an application archive/checkpoint implementation.
ALTER TABLE execution.conversations RENAME COLUMN workspace_checkpoint TO legacy_workspace_checkpoint;

-- migrate:down
ALTER TABLE execution.conversations RENAME COLUMN legacy_workspace_checkpoint TO workspace_checkpoint;
ALTER TABLE execution.conversations DROP CONSTRAINT native_sandbox_reference,
  DROP COLUMN native_sandbox, DROP COLUMN sandbox_recovery_required;
