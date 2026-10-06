-- migrate:up
-- Validate retained rows as-is. Inconsistent historical authority must fail the
-- migration, not be rewritten, detached, or silently deleted.
ALTER TABLE product.command_outbox
  DROP CONSTRAINT command_outbox_message_id_fkey,
  ADD CONSTRAINT command_outbox_message_identity
    FOREIGN KEY (thread_id, message_id)
    REFERENCES product.messages (thread_id, message_id);

ALTER TABLE execution.command_inbox
  ADD CONSTRAINT command_inbox_run_identity UNIQUE (thread_id, run_id, command_id);
ALTER TABLE execution.runs
  ADD CONSTRAINT runs_thread_identity UNIQUE (thread_id, run_id),
  DROP CONSTRAINT runs_command_id_fkey,
  ADD CONSTRAINT runs_command_identity
    FOREIGN KEY (thread_id, run_id, command_id)
    REFERENCES execution.command_inbox (thread_id, run_id, command_id);
ALTER TABLE execution.event_outbox
  DROP CONSTRAINT event_outbox_run_id_fkey,
  ADD CONSTRAINT event_outbox_run_identity
    FOREIGN KEY (thread_id, run_id)
    REFERENCES execution.runs (thread_id, run_id);

-- Admission creates an idle conversation, then its run, then claims the lease.
-- Terminal release clears the complete lease triple explicitly. NO ACTION is
-- intentional: deleting a run must never clear lease authority or recovery state.
ALTER TABLE execution.conversations
  ADD CONSTRAINT conversations_active_run_identity
    FOREIGN KEY (thread_id, active_run_id)
    REFERENCES execution.runs (thread_id, run_id);

-- migrate:down
ALTER TABLE execution.conversations DROP CONSTRAINT conversations_active_run_identity;
ALTER TABLE execution.event_outbox
  DROP CONSTRAINT event_outbox_run_identity,
  ADD CONSTRAINT event_outbox_run_id_fkey
    FOREIGN KEY (run_id) REFERENCES execution.runs (run_id);
ALTER TABLE execution.runs
  DROP CONSTRAINT runs_command_identity,
  DROP CONSTRAINT runs_thread_identity,
  ADD CONSTRAINT runs_command_id_fkey
    FOREIGN KEY (command_id) REFERENCES execution.command_inbox (command_id);
ALTER TABLE execution.command_inbox DROP CONSTRAINT command_inbox_run_identity;
ALTER TABLE product.command_outbox
  DROP CONSTRAINT command_outbox_message_identity,
  ADD CONSTRAINT command_outbox_message_id_fkey
    FOREIGN KEY (message_id) REFERENCES product.messages (message_id);
