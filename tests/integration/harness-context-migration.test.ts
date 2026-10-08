import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { Client } from 'pg'
import { readMigrationEnv } from '@vid/config'
import { testDatabaseOptions, verifyTestDatabase } from './database-fixture'

const migrationPath = 'packages/database/migrations/20261008000000_harness_context.sql'

/** Only the launcher-admitted database and locally generated namespaces receive
 * DDL. Execute the whole migration, changing schema qualifiers, not its logic. */
async function legacyFixture() {
  const db = new Client(testDatabaseOptions(readMigrationEnv().DATABASE_URL))
  const suffix = crypto.randomUUID().replaceAll('-', '')
  const execution = `context_execution_${suffix}`
  const product = `context_product_${suffix}`
  const qualify = (sql: string) =>
    sql.replaceAll('execution.', `${execution}.`).replaceAll('product.', `${product}.`)
  const query = (sql: string, values: unknown[] = []) => db.query(qualify(sql), values)
  let owned = false
  const close = async () => {
    try {
      if (owned) {
        await db.query('ROLLBACK')
        await db.query(`DROP SCHEMA IF EXISTS ${execution} CASCADE`)
        await db.query(`DROP SCHEMA IF EXISTS ${product} CASCADE`)
      }
    } finally {
      await db.end()
    }
  }
  try {
    await db.connect()
    await verifyTestDatabase(db)
    // These names consist exclusively of a fixed prefix and a generated UUID.
    owned = true
    await db.query(`CREATE SCHEMA ${execution}; CREATE SCHEMA ${product}`)
    await query(`
      CREATE TABLE execution.conversations (
        thread_id uuid PRIMARY KEY,
        native_session_id uuid NOT NULL,
        harness_engine text,
        native_state_initialized boolean NOT NULL DEFAULT false,
        active_run_id uuid
      );
      CREATE TABLE execution.runs (
        run_id uuid PRIMARY KEY,
        thread_id uuid NOT NULL REFERENCES execution.conversations(thread_id),
        assistant_message_id uuid,
        status text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX runs_thread_status_idx ON execution.runs(thread_id,status,created_at);
      CREATE TABLE product.command_outbox (
        command_id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz
      );
      CREATE TABLE execution.event_outbox (
        event_id uuid PRIMARY KEY, thread_id uuid NOT NULL, run_id uuid NOT NULL,
        ordinal integer NOT NULL, event jsonb NOT NULL
      );
      CREATE TABLE product.execution_events (
        event_id uuid PRIMARY KEY, thread_id uuid NOT NULL, run_id uuid NOT NULL,
        payload jsonb NOT NULL
      );
      CREATE UNIQUE INDEX execution_events_run_terminal_idx ON product.execution_events(run_id)
        WHERE payload ->> 'kind' IN ('run-completed','run-cancelled','run-failed')
    `)
    const source = await readFile(migrationPath, 'utf8')
    const [up, down] = source.split('-- migrate:down')
    if (!up || !down) throw new Error('Expected both migration directions')
    const apply = async (sql: string) => {
      await db.query('BEGIN')
      try {
        await query(sql)
        await db.query('COMMIT')
      } catch (cause) {
        await db.query('ROLLBACK')
        throw cause
      }
    }
    const validate = async () => {
      const source = await readFile(
        'packages/database/migrations/20261008030000_harness_completion_provenance.sql',
        'utf8',
      )
      const [validation] = source.split('-- migrate:down')
      if (!validation) throw new Error('Expected provenance migration up direction')
      await apply(validation)
    }
    const advance = async () => {
      await apply(up)
      for (const name of [
        '20261008010000_harness_queries',
        '20261008020000_command_outbox_pending',
      ]) {
        const source = await readFile(`packages/database/migrations/${name}.sql`, 'utf8')
        const [next] = source.split('-- migrate:down')
        if (!next) throw new Error('Expected intermediate migration up direction')
        await apply(next)
      }
    }
    return { query, close, up: advance, down: () => apply(down), validate }
  } catch (cause) {
    try {
      await close()
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Legacy context fixture setup failed')
    }
    throw cause
  }
}

type Fixture = Awaited<ReturnType<typeof legacyFixture>>

async function seedConversation(
  fixture: Fixture,
  engine: 'pi' | 'openai' | null,
  initialized: boolean,
) {
  const threadID = crypto.randomUUID()
  const sessionID = crypto.randomUUID()
  await fixture.query('INSERT INTO execution.conversations VALUES ($1,$2,$3,$4)', [
    threadID,
    sessionID,
    engine,
    initialized,
  ])
  return { threadID, sessionID }
}

async function seedRun(
  fixture: Fixture,
  threadID: string,
  status = 'completed',
  messageID: string | null = crypto.randomUUID(),
) {
  const runID = crypto.randomUUID()
  await fixture.query('INSERT INTO execution.runs VALUES ($1,$2,$3,$4)', [
    runID,
    threadID,
    messageID,
    status,
  ])
  return { threadID, runID, messageID }
}

async function seedFinal(
  fixture: Fixture,
  run: Awaited<ReturnType<typeof seedRun>>,
  source: 'outbox' | 'receipt',
  overrides: Record<string, unknown> = {},
) {
  const eventID = crypto.randomUUID()
  const payload = {
    version: 1,
    kind: 'run-completed',
    eventID: eventID.toUpperCase(),
    threadID: run.threadID,
    runID: run.runID,
    messageID: run.messageID,
    text: 'Historical completed answer',
    ...overrides,
  }
  if (source === 'outbox') {
    await fixture.query('INSERT INTO execution.event_outbox VALUES ($1,$2,$3,1,$4)', [
      eventID,
      run.threadID,
      run.runID,
      payload,
    ])
  } else {
    await fixture.query('INSERT INTO product.execution_events VALUES ($1,$2,$3,$4)', [
      eventID,
      run.threadID,
      run.runID,
      payload,
    ])
  }
}

test('context migration retains legacy session engines and initialization and binds only accepted runs', async () => {
  const fixture = await legacyFixture()
  try {
    for (const engine of ['pi', 'openai', null] as const) {
      const initialized = engine === 'pi'
      const conversation = await seedConversation(fixture, engine, initialized)
      await seedRun(fixture, conversation.threadID)
      await seedRun(fixture, conversation.threadID, 'failed')
      await seedRun(fixture, conversation.threadID, 'queued', null)
    }
    await fixture.up()
    const sessions = await fixture.query(
      'SELECT harness_engine,storage,initialized,initial_context FROM execution.native_sessions ORDER BY harness_engine',
    )
    expect(sessions.rows).toEqual([
      { harness_engine: 'openai', storage: 'legacy', initialized: false, initial_context: null },
      { harness_engine: 'pi', storage: 'legacy', initialized: true, initial_context: null },
    ])
    const runs = await fixture.query(`
      SELECT conversation.harness_engine,run.status,
        run.native_session_id = conversation.native_session_id AS same_session,
        run.completion, conversation.requested_engine
      FROM execution.runs run JOIN execution.conversations conversation USING (thread_id)
      ORDER BY conversation.harness_engine NULLS LAST,run.status
    `)
    expect(runs.rows).toEqual(
      ['openai', 'pi', null].flatMap((harness_engine) =>
        ['completed', 'failed', 'queued'].map((status) => ({
          harness_engine,
          status,
          same_session: harness_engine !== null && status !== 'queued' ? true : null,
          completion: null,
          requested_engine: null,
        })),
      ),
    )
  } finally {
    await fixture.close()
  }
})

test.each([
  "UPDATE execution.native_sessions SET harness_engine='openai'",
  "UPDATE execution.native_sessions SET storage='session'",
  'UPDATE execution.native_sessions SET initialized=false',
  `UPDATE execution.native_sessions SET initial_context='{}'::jsonb`,
])(
  'native session binding rejects identity context or initialized proof rewrite: %s',
  async (update) => {
    const fixture = await legacyFixture()
    try {
      const { threadID } = await seedConversation(fixture, 'pi', true)
      await seedRun(fixture, threadID)
      await fixture.up()
      await Promise.resolve(
        expect(fixture.query(update)).rejects.toThrow('Native session binding is immutable'),
      )
    } finally {
      await fixture.close()
    }
  },
)

const finalCases = [
  { name: 'outbox', source: 'outbox', recover: true },
  { name: 'receipt', source: 'receipt', recover: true },
  { name: 'duplicate', source: 'outbox', recover: true, secondText: 'Historical completed answer' },
  { name: 'contradictory', source: 'outbox', recover: false, secondText: 'Contradictory answer' },
  {
    name: 'wrong-thread',
    source: 'outbox',
    recover: false,
    overrides: { threadID: 'aaaaaaaa-0000-4000-8000-000000000001' },
  },
  {
    name: 'wrong-run',
    source: 'receipt',
    recover: false,
    overrides: { runID: 'bbbbbbbb-0000-4000-8000-000000000002' },
  },
  {
    name: 'wrong-message',
    source: 'outbox',
    recover: false,
    overrides: { messageID: 'cccccccc-0000-4000-8000-000000000003' },
  },
  { name: 'wrong-version', source: 'receipt', recover: false, overrides: { version: 2 } },
  { name: 'wrong-kind', source: 'outbox', recover: false, overrides: { kind: 'run-failed' } },
  { name: 'failed', source: 'outbox', recover: false },
  { name: 'missing', source: 'outbox', recover: false },
] satisfies {
  name: string
  source: 'outbox' | 'receipt'
  recover: boolean
  secondText?: string
  overrides?: Record<string, unknown>
}[]

test.each(finalCases)(
  'context migration recovers only matching consistent completed results: $name',
  async (scenario) => {
    const fixture = await legacyFixture()
    try {
      const { threadID } = await seedConversation(fixture, 'pi', true)
      const run = await seedRun(
        fixture,
        threadID,
        scenario.name === 'failed' ? 'failed' : 'completed',
      )
      const assetID = crypto.randomUUID()
      const asset = {
        assetID,
        name: 'answer.txt',
        mimeType: 'text/plain',
        byteLength: 3,
        sha256: 'a'.repeat(64),
        objectKey: `assets/generated/${threadID}/${run.runID}/1/${assetID}`,
      }
      const headers =
        scenario.name === 'receipt'
          ? {
              threadID: threadID.toUpperCase(),
              runID: run.runID.toUpperCase(),
              messageID: run.messageID?.toUpperCase(),
            }
          : {}
      if (scenario.name !== 'missing')
        await seedFinal(fixture, run, scenario.source, {
          assets: [asset],
          ...headers,
          ...scenario.overrides,
        })
      if (scenario.secondText !== undefined)
        await seedFinal(fixture, run, 'receipt', {
          assets: [asset],
          text: scenario.secondText,
        })
      await fixture.up()
      const row = await fixture.query('SELECT completion FROM execution.runs WHERE run_id=$1', [
        run.runID,
      ])
      expect(row.rows).toEqual([
        {
          completion: scenario.recover
            ? { text: 'Historical completed answer', assets: [asset] }
            : null,
        },
      ])
    } finally {
      await fixture.close()
    }
  },
)

test('context migration makes accepted session binding immutable and rollback fails closed', async () => {
  const fixture = await legacyFixture()
  try {
    const { threadID, sessionID } = await seedConversation(fixture, 'pi', true)
    const accepted = await seedRun(fixture, threadID)
    const pending = await seedRun(fixture, threadID, 'queued', null)
    await fixture.up()
    const replacement = crypto.randomUUID()
    await fixture.query(
      "INSERT INTO execution.native_sessions (native_session_id,thread_id,harness_engine,storage) VALUES ($1,$2,'openai','session')",
      [replacement, threadID],
    )
    for (const target of [replacement, null]) {
      await Promise.resolve(
        expect(
          fixture.query('UPDATE execution.runs SET native_session_id=$1 WHERE run_id=$2', [
            target,
            accepted.runID,
          ]),
        ).rejects.toThrow('Accepted native session binding is immutable'),
      )
    }
    await fixture.query('UPDATE execution.runs SET native_session_id=$1 WHERE run_id=$2', [
      sessionID,
      accepted.runID,
    ])
    await fixture.query('UPDATE execution.runs SET native_session_id=$1 WHERE run_id=$2', [
      replacement,
      pending.runID,
    ])
    await Promise.resolve(
      expect(fixture.down()).rejects.toThrow('requires explicit offline rollback'),
    )
    const rows = await fixture.query(
      'SELECT run_id,native_session_id FROM execution.runs ORDER BY run_id',
    )
    expect(rows.rows).toEqual(
      [
        { run_id: accepted.runID, native_session_id: sessionID },
        { run_id: pending.runID, native_session_id: replacement },
      ].sort((a, b) => a.run_id.localeCompare(b.run_id)),
    )
    await Promise.resolve(
      expect(
        fixture.query('UPDATE execution.runs SET native_session_id=NULL WHERE run_id=$1', [
          pending.runID,
        ]),
      ).rejects.toThrow('Accepted native session binding is immutable'),
    )
  } finally {
    await fixture.close()
  }
})

async function retainedState(fixture: Fixture) {
  const result = await fixture.query(`
    SELECT
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY run_id) FROM execution.runs r) AS runs,
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY native_session_id) FROM execution.native_sessions s) AS sessions,
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM execution.event_outbox e) AS outbox,
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM product.execution_events e) AS receipts
  `)
  return result.rows
}

const provenanceCases = [
  { name: 'string version', overrides: { version: '1' } },
  { name: 'receipt string version', source: 'receipt', overrides: { version: '1' } },
  { name: 'receipt wrong eventID', source: 'receipt', overrides: { eventID: crypto.randomUUID() } },
  { name: 'wrong eventID', overrides: { eventID: crypto.randomUUID() } },
  { name: 'missing eventID', overrides: { eventID: null } },
  { name: 'wrong threadID', overrides: { threadID: crypto.randomUUID() } },
  { name: 'wrong runID', overrides: { runID: crypto.randomUUID() } },
  { name: 'wrong messageID', overrides: { messageID: crypto.randomUUID() } },
  { name: 'wrong numeric version', overrides: { version: 2 } },
  { name: 'contradictory results', second: { text: 'Contradictory answer' } },
  { name: 'canonical and malformed duplicate', second: { version: '1' } },
  { name: 'canonical and null version duplicate', second: { version: null } },
  { name: 'canonical and missing identity duplicate', second: { eventID: null } },
  { name: 'completion conflicts with retained proof', completionText: 'Different completion' },
  { name: 'authoritative completion with pruned ledger', prune: true },
] satisfies {
  name: string
  overrides?: Record<string, unknown>
  second?: Record<string, unknown>
  source?: 'outbox' | 'receipt'
  completionText?: string
  prune?: boolean
}[]

test.each(provenanceCases)(
  'old then forward provenance migration requires offline recovery without mutation: $name',
  async (scenario) => {
    const fixture = await legacyFixture()
    try {
      const { threadID } = await seedConversation(fixture, 'pi', true)
      const run = await seedRun(fixture, threadID)
      await seedFinal(fixture, run, scenario.source ?? 'outbox', scenario.overrides)
      if (scenario.second !== undefined) await seedFinal(fixture, run, 'receipt', scenario.second)
      await fixture.up()
      if (scenario.name === 'string version' || scenario.name === 'wrong eventID') {
        const promoted = await fixture.query('SELECT completion FROM execution.runs')
        expect(promoted.rows).toEqual([{ completion: { text: 'Historical completed answer' } }])
      }
      if (scenario.completionText !== undefined)
        await fixture.query('UPDATE execution.runs SET completion=$1', [
          { text: scenario.completionText },
        ])
      if (scenario.prune) await fixture.query('DELETE FROM execution.event_outbox')
      const before = await retainedState(fixture)
      await Promise.resolve(
        expect(fixture.validate()).rejects.toThrow('requires explicit offline recovery'),
      )
      expect(await retainedState(fixture)).toEqual(before)
    } finally {
      await fixture.close()
    }
  },
)

test.each(['outbox', 'receipt', 'both'] as const)(
  'old then forward provenance migration accepts uppercase identities and consistent duplicates: %s',
  async (source) => {
    const fixture = await legacyFixture()
    try {
      const { threadID } = await seedConversation(fixture, 'pi', true)
      const run = await seedRun(fixture, threadID)
      const headers = {
        threadID: threadID.toUpperCase(),
        runID: run.runID.toUpperCase(),
        messageID: run.messageID?.toUpperCase(),
        assets: [],
        sources: [],
      }
      await seedFinal(fixture, run, source === 'receipt' ? 'receipt' : 'outbox', headers)
      if (source === 'both') {
        await fixture.query(`
          INSERT INTO product.execution_events (event_id,thread_id,run_id,payload)
          SELECT event_id,thread_id,run_id,event FROM execution.event_outbox
        `)
      }
      await fixture.up()
      const before = await retainedState(fixture)
      await fixture.validate()
      expect(await retainedState(fixture)).toEqual(before)
    } finally {
      await fixture.close()
    }
  },
)

test('forward provenance migration accepts missing history only when no completion was promoted', async () => {
  const fixture = await legacyFixture()
  try {
    const { threadID } = await seedConversation(fixture, 'pi', true)
    await seedRun(fixture, threadID)
    await fixture.up()
    const before = await retainedState(fixture)
    await fixture.validate()
    expect(await retainedState(fixture)).toEqual(before)
  } finally {
    await fixture.close()
  }
})

test.each([false, true])(
  'forward provenance migration preserves already seeded immutable context and requires offline recovery (pruned=%s)',
  async (pruned) => {
    const fixture = await legacyFixture()
    try {
      const { threadID } = await seedConversation(fixture, 'pi', true)
      const run = await seedRun(fixture, threadID)
      await seedFinal(fixture, run, 'outbox')
      await fixture.up()
      await fixture.query(
        `INSERT INTO execution.native_sessions
          (native_session_id,thread_id,harness_engine,storage,initial_context)
         VALUES ($1,$2,'openai','session',$3)`,
        [
          crypto.randomUUID(),
          threadID,
          {
            version: 1,
            throughRunID: run.runID,
            turns: [
              {
                runID: run.runID,
                input: { messageID: crypto.randomUUID(), text: 'Historical input' },
                output: { messageID: run.messageID, text: 'Historical completed answer' },
              },
            ],
          },
        ],
      )
      if (pruned) await fixture.query('DELETE FROM execution.event_outbox')
      const before = await retainedState(fixture)
      await Promise.resolve(
        expect(fixture.validate()).rejects.toThrow('requires explicit offline recovery'),
      )
      expect(await retainedState(fixture)).toEqual(before)
    } finally {
      await fixture.close()
    }
  },
)

test('forward provenance migration cannot infer authority for a post-backfill completion without retained ledgers', async () => {
  const fixture = await legacyFixture()
  try {
    const { threadID } = await seedConversation(fixture, 'pi', true)
    await seedRun(fixture, threadID)
    await fixture.up()
    // Same storage shape as terminal-writes.ts, but no historical backfill:
    // source authority is deliberately not encoded in the completion column.
    await fixture.query('UPDATE execution.runs SET completion=$1', [
      { text: 'Authoritative later answer', assets: [], sources: [] },
    ])
    const before = await retainedState(fixture)
    await Promise.resolve(
      expect(fixture.validate()).rejects.toThrow('requires explicit offline recovery'),
    )
    expect(await retainedState(fixture)).toEqual(before)
  } finally {
    await fixture.close()
  }
})

test('forward provenance migration rejects a retained eventID naming two otherwise canonical runs', async () => {
  const fixture = await legacyFixture()
  try {
    const { threadID } = await seedConversation(fixture, 'pi', true)
    const first = await seedRun(fixture, threadID)
    const second = await seedRun(fixture, threadID)
    await seedFinal(fixture, first, 'outbox')
    await fixture.query(
      `INSERT INTO product.execution_events (event_id,thread_id,run_id,payload)
       SELECT event_id,thread_id,$1,event || $2
       FROM execution.event_outbox`,
      [second.runID, { runID: second.runID, messageID: second.messageID }],
    )
    await fixture.up()
    const promoted = await fixture.query(
      'SELECT count(*) FROM execution.runs WHERE completion IS NOT NULL',
    )
    expect(promoted.rows).toEqual([{ count: '2' }])
    const before = await retainedState(fixture)
    await Promise.resolve(
      expect(fixture.validate()).rejects.toThrow('requires explicit offline recovery'),
    )
    expect(await retainedState(fixture)).toEqual(before)
  } finally {
    await fixture.close()
  }
})

test.each([
  { source: 'outbox', kind: 'run-failed' },
  { source: 'outbox', kind: 'run-started' },
  { source: 'outbox', kind: null },
  { source: 'receipt', kind: 'run-failed' },
  { source: 'receipt', kind: 'run-started' },
  { source: 'receipt', kind: null },
])(
  'forward provenance migration rejects a completed eventID shared with another kind (completed=$source, other=$kind)',
  async ({ source, kind }) => {
    const fixture = await legacyFixture()
    try {
      const { threadID } = await seedConversation(fixture, 'pi', true)
      const run = await seedRun(fixture, threadID)
      await seedFinal(fixture, run, source === 'receipt' ? 'receipt' : 'outbox')
      if (source === 'outbox') {
        await fixture.query(
          `INSERT INTO product.execution_events (event_id,thread_id,run_id,payload)
           SELECT event_id,thread_id,run_id,event || $1 FROM execution.event_outbox`,
          [{ kind }],
        )
      } else {
        await fixture.query(
          `INSERT INTO execution.event_outbox (event_id,thread_id,run_id,ordinal,event)
           SELECT event_id,thread_id,run_id,1,payload || $1 FROM product.execution_events`,
          [{ kind }],
        )
      }
      await fixture.up()
      const promoted = await fixture.query('SELECT completion FROM execution.runs')
      expect(promoted.rows).toEqual([{ completion: { text: 'Historical completed answer' } }])
      const before = await retainedState(fixture)
      await Promise.resolve(
        expect(fixture.validate()).rejects.toThrow('requires explicit offline recovery'),
      )
      expect(await retainedState(fixture)).toEqual(before)
    } finally {
      await fixture.close()
    }
  },
)

test('forward provenance migration does not audit other kinds with no completed eventID collision', async () => {
  const fixture = await legacyFixture()
  try {
    const { threadID } = await seedConversation(fixture, 'pi', true)
    const run = await seedRun(fixture, threadID)
    await seedFinal(fixture, run, 'outbox')
    await seedFinal(fixture, run, 'receipt', { kind: 'run-failed' })
    await fixture.query(`
      INSERT INTO execution.event_outbox (event_id,thread_id,run_id,ordinal,event)
      SELECT event_id,thread_id,run_id,2,payload || '{"kind":"run-started"}'::jsonb
      FROM product.execution_events
    `)
    await fixture.up()
    const before = await retainedState(fixture)
    await fixture.validate()
    expect(await retainedState(fixture)).toEqual(before)
  } finally {
    await fixture.close()
  }
})
