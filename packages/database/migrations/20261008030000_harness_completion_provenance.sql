-- migrate:up
-- Stop server and execution workers before applying. This is validation only:
-- never erase a completion, a retained ledger, or an immutable context to pass.
-- The historical context backfill accepted JSON string versions and discarded
-- ledger event_id. There is no persisted marker distinguishing that backfill
-- from a later authoritative completion, so a non-null completion whose ledgers
-- were pruned also requires offline recovery, even if it was legitimately written.
-- Seeded immutable snapshots require offline review regardless of retained proof:
-- their historical source/consumption cannot be established by comparing outputs.
-- Recovery must preserve evidence and establish external authority for both run
-- results and native segments before an explicitly reviewed offline deployment;
-- this migration supplies neither an automatic repair nor an online bypass.
LOCK TABLE execution.runs, execution.native_sessions,
  execution.event_outbox, product.execution_events IN SHARE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM execution.native_sessions WHERE initial_context IS NOT NULL) THEN
    RAISE EXCEPTION 'Harness completion provenance requires explicit offline recovery: immutable context snapshots already seeded';
  END IF;

  IF EXISTS (
    WITH retained AS (
      SELECT event_id, thread_id, run_id, event AS payload
      FROM execution.event_outbox
      UNION ALL
      SELECT event_id, thread_id, run_id, payload
      FROM product.execution_events
    ), finals AS (
      SELECT * FROM retained WHERE payload ->> 'kind' = 'run-completed'
    ), proof AS (
      SELECT run.run_id, run.status, run.completion,
        count(finals.event_id) AS retained,
        bool_and((
          finals.payload -> 'version' = to_jsonb(1)
          AND lower(finals.payload ->> 'eventID') = finals.event_id::text
          AND finals.thread_id = run.thread_id
          AND lower(finals.payload ->> 'threadID') = run.thread_id::text
          AND lower(finals.payload ->> 'runID') = run.run_id::text
          AND lower(finals.payload ->> 'messageID') = run.assistant_message_id::text
        ) IS TRUE) AS canonical,
        count(DISTINCT finals.payload - ARRAY['version', 'kind', 'eventID', 'threadID', 'runID', 'messageID']) AS results,
        bool_and(
          finals.payload - ARRAY['version', 'kind', 'eventID', 'threadID', 'runID', 'messageID'] = run.completion
        ) AS agrees
      FROM execution.runs AS run
      LEFT JOIN finals ON finals.run_id = run.run_id
      WHERE run.status = 'completed' OR run.completion IS NOT NULL
      GROUP BY run.run_id, run.status, run.completion
    )
    SELECT 1 FROM proof
    WHERE (retained > 0 AND (canonical IS DISTINCT FROM true OR results <> 1))
       OR (completion IS NOT NULL AND
           (status <> 'completed' OR retained = 0 OR agrees IS DISTINCT FROM true))
    UNION ALL
    -- A completed event identity cannot name different facts of any kind across
    -- the two ledgers. Other event identities are outside this provenance gate.
    -- Normalize UUID letter case, but retain kind and identity when comparing.
    SELECT 1 FROM retained
    WHERE event_id IN (SELECT event_id FROM finals)
    GROUP BY event_id
    HAVING count(DISTINCT ROW(
      thread_id, run_id, payload -> 'kind', lower(payload ->> 'messageID'),
      payload - ARRAY['version', 'kind', 'eventID', 'threadID', 'runID', 'messageID']
    )) > 1
  ) THEN
    RAISE EXCEPTION 'Harness completion provenance requires explicit offline recovery: missing, malformed or contradictory retained terminal proof';
  END IF;
END
$$;

-- migrate:down
-- Validation changed no rows or schema; rollback must not imply unvalidated
-- historical completions are safe for an older context consumer.
DO $$ BEGIN RAISE EXCEPTION 'Harness completion provenance requires explicit offline rollback'; END $$;
