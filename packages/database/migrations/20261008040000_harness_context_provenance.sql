-- migrate:up
-- Revalidate installations that already applied 20261008030000. The standalone
-- predicates intentionally match that gate; dbmate has no migration include.
-- Stop server and execution workers before applying. This is validation only:
-- never erase a completion, a retained ledger, or an immutable context to pass.
-- The historical context backfill accepted JSON string versions and discarded
-- ledger event_id. There is no persisted marker distinguishing that backfill
-- from a later authoritative completion, so a non-null completion whose ledgers
-- were pruned also requires offline recovery, even if it was legitimately written.
-- Snapshot equality proves retained business material only, not native checkpoint
-- freshness, historical consumption, or causal source. Native SDK identity,
-- bootstrap commitment and initialized-state checks remain runtime obligations.
LOCK TABLE execution.runs, execution.native_sessions,
  execution.command_inbox, execution.event_outbox, product.execution_events IN SHARE MODE;

DO $$
BEGIN
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

  IF EXISTS (
    WITH snapshots AS (
      SELECT session.*, cutoff.run_id AS cutoff_id, cutoff.created_at AS cutoff_at
      FROM execution.native_sessions AS session
      LEFT JOIN execution.runs AS cutoff
        ON cutoff.thread_id = session.thread_id
        AND cutoff.run_id::text = session.initial_context ->> 'throughRunID'
        AND cutoff.status = 'completed'
      WHERE session.initial_context IS NOT NULL
    ), prefixes AS (
      SELECT snapshot.native_session_id,
        coalesce(jsonb_agg(jsonb_build_object(
          'runID', run.run_id,
          'input', (inbox.command -> 'input') || jsonb_build_object('messageID', run.message_id)
            || CASE WHEN jsonb_typeof(inbox.command -> 'input' -> 'assets') = 'array' THEN
              jsonb_build_object('assets', coalesce((
                SELECT jsonb_agg(asset || jsonb_build_object('assetID', lower(asset ->> 'assetID')) ORDER BY position)
                FROM jsonb_array_elements(inbox.command -> 'input' -> 'assets') WITH ORDINALITY AS items(asset, position)
              ), '[]'::jsonb)) ELSE '{}'::jsonb END,
          'output', jsonb_build_object('messageID', run.assistant_message_id) || run.completion
            || CASE WHEN jsonb_typeof(run.completion -> 'assets') = 'array' THEN
              jsonb_build_object('assets', coalesce((
                SELECT jsonb_agg(asset || jsonb_build_object('assetID', lower(asset ->> 'assetID')) ORDER BY position)
                FROM jsonb_array_elements(run.completion -> 'assets') WITH ORDINALITY AS items(asset, position)
              ), '[]'::jsonb)) ELSE '{}'::jsonb END
        ) ORDER BY run.created_at, run.run_id) FILTER (WHERE run.run_id IS NOT NULL), '[]'::jsonb) AS turns,
        bool_and((
          inbox.command_id = run.command_id
          AND inbox.thread_id = run.thread_id AND inbox.run_id = run.run_id
          AND inbox.kind = 'start' AND inbox.command -> 'version' = to_jsonb(1)
          AND inbox.command ->> 'kind' = 'start'
          AND lower(inbox.command ->> 'commandID') = run.command_id::text
          AND lower(inbox.command ->> 'threadID') = run.thread_id::text
          AND lower(inbox.command ->> 'runID') = run.run_id::text
          AND lower(inbox.command -> 'input' ->> 'messageID') = run.message_id::text
          AND inbox.command -> 'input' ->> 'text' = run.text
          AND jsonb_typeof(inbox.command -> 'input' -> 'text') = 'string'
          AND jsonb_typeof(inbox.command -> 'input') = 'object'
          AND (inbox.command -> 'input') - ARRAY['messageID', 'text', 'assets'] = '{}'::jsonb
          AND inbox.command - ARRAY['version', 'kind', 'commandID', 'threadID', 'runID', 'input'] = '{}'::jsonb
          AND run.assistant_message_id IS NOT NULL
          AND jsonb_typeof(run.completion) = 'object'
          AND jsonb_typeof(run.completion -> 'text') = 'string'
          AND run.completion - ARRAY['text', 'assets', 'sources'] = '{}'::jsonb
        ) IS TRUE) FILTER (WHERE run.run_id IS NOT NULL) AS accepted
      FROM snapshots AS snapshot
      LEFT JOIN execution.runs AS run
        ON run.thread_id = snapshot.thread_id AND run.status = 'completed'
        AND (run.created_at, run.run_id) <= (snapshot.cutoff_at, snapshot.cutoff_id)
      LEFT JOIN execution.command_inbox AS inbox ON inbox.command_id = run.command_id
      GROUP BY snapshot.native_session_id
    )
    SELECT 1 FROM snapshots AS snapshot
    JOIN prefixes USING (native_session_id)
    WHERE (snapshot.initial_context -> 'throughRunID' <> 'null'::jsonb AND snapshot.cutoff_id IS NULL)
       OR prefixes.accepted IS FALSE
       OR snapshot.initial_context IS DISTINCT FROM jsonb_build_object(
         'version', 1, 'throughRunID', snapshot.cutoff_id, 'turns', prefixes.turns
       )
  ) THEN
    RAISE EXCEPTION 'Harness context provenance requires explicit offline recovery: snapshot differs from retained accepted completed prefix';
  END IF;
END
$$;

-- migrate:down
-- Validation changed no rows or schema; rollback must not imply unvalidated
-- historical completions are safe for an older context consumer.
DO $$ BEGIN RAISE EXCEPTION 'Harness completion provenance requires explicit offline rollback'; END $$;
