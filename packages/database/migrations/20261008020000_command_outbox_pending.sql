-- migrate:up
-- Published commands remain replay authority. Bound the relay's ordered pending
-- window independently of retained history; no command payload is indexed.
-- Apply with the server stopped: this ordinary index build takes a table lock.
CREATE INDEX command_outbox_pending_idx
  ON product.command_outbox (created_at, command_id)
  WHERE published_at IS NULL;

-- migrate:down
DROP INDEX product.command_outbox_pending_idx;
