-- migrate:up
-- Apply with the execution worker stopped. Business results remain separate from
-- SDK checkpoints: these rows cannot settle unknown effects or resume a loop.
CREATE TABLE execution.native_sessions (
  native_session_id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES execution.conversations(thread_id) ON DELETE CASCADE,
  harness_engine text NOT NULL CHECK (harness_engine IN ('pi', 'openai')),
  storage text NOT NULL CHECK (storage IN ('legacy', 'session')),
  initialized boolean NOT NULL DEFAULT false,
  initial_context jsonb,
  UNIQUE (thread_id, native_session_id)
);

INSERT INTO execution.native_sessions
  (native_session_id, thread_id, harness_engine, storage, initialized)
SELECT native_session_id, thread_id, harness_engine, 'legacy', native_state_initialized
FROM execution.conversations WHERE harness_engine IS NOT NULL;

ALTER TABLE execution.conversations
  ADD COLUMN requested_engine text CHECK (requested_engine IN ('pi', 'openai'));
ALTER TABLE execution.runs
  ADD COLUMN native_session_id uuid,
  ADD COLUMN completion jsonb,
  ADD CONSTRAINT runs_native_session_fk FOREIGN KEY (thread_id, native_session_id)
    REFERENCES execution.native_sessions(thread_id, native_session_id);

UPDATE execution.runs AS run
SET native_session_id = conversation.native_session_id
FROM execution.conversations AS conversation
WHERE run.thread_id = conversation.thread_id
  AND conversation.harness_engine IS NOT NULL
  AND run.assistant_message_id IS NOT NULL;

-- Backfill only an identity-matching completed terminal. Missing historical
-- finals require explicit preparation, never an invented empty conversation.
WITH finals AS (
  SELECT thread_id, run_id, event AS payload FROM execution.event_outbox
  WHERE event ->> 'kind' = 'run-completed'
  UNION ALL
  SELECT thread_id, run_id, payload FROM product.execution_events
  WHERE payload ->> 'kind' = 'run-completed'
), matched AS (
  SELECT run.run_id,
    finals.payload - ARRAY['version', 'kind', 'eventID', 'threadID', 'runID', 'messageID'] AS result
  FROM execution.runs AS run JOIN finals
    ON run.thread_id = finals.thread_id AND run.run_id = finals.run_id
  WHERE run.status = 'completed' AND finals.payload ->> 'version' = '1'
    AND lower(finals.payload ->> 'threadID') = run.thread_id::text
    AND lower(finals.payload ->> 'runID') = run.run_id::text
    AND lower(finals.payload ->> 'messageID') = run.assistant_message_id::text
), consistent AS (
  SELECT run_id, (jsonb_agg(DISTINCT result) -> 0) AS result FROM matched
  GROUP BY run_id HAVING count(DISTINCT result) = 1
)
UPDATE execution.runs AS run SET completion = consistent.result
FROM consistent WHERE run.run_id = consistent.run_id;

-- A later executor selection cannot reinterpret a previously bound run.
CREATE FUNCTION execution.keep_run_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.native_session_id IS NOT NULL
     AND NEW.native_session_id IS DISTINCT FROM OLD.native_session_id THEN
    RAISE EXCEPTION 'Accepted native session binding is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER keep_run_session BEFORE UPDATE ON execution.runs
FOR EACH ROW EXECUTE FUNCTION execution.keep_run_session();

-- A stable run pointer is insufficient if its referenced engine/layout/context
-- can change. Checkpoint proof may advance, never regress.
CREATE FUNCTION execution.keep_native_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.native_session_id, NEW.thread_id, NEW.harness_engine, NEW.storage, NEW.initial_context)
       IS DISTINCT FROM
       ROW(OLD.native_session_id, OLD.thread_id, OLD.harness_engine, OLD.storage, OLD.initial_context)
     OR (OLD.initialized AND NOT NEW.initialized) THEN
    RAISE EXCEPTION 'Native session binding is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER keep_native_session BEFORE UPDATE ON execution.native_sessions
FOR EACH ROW EXECUTE FUNCTION execution.keep_native_session();

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Harness context replacement requires explicit offline rollback'; END $$;
