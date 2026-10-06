import { afterAll, expect, test } from 'bun:test'
import { restorePiHistory } from '../../apps/agent/src/harness/pi-history'
import { sql } from 'kysely'
import { acceptExecutionCommand } from '../../apps/agent/src/db/command-acceptance'
import { claimExecutionRun } from '../../apps/agent/src/db/execution-leases'
import { completeExecutionRun } from '../../apps/agent/src/db/run-writes'
import { executionEventSchema } from '@vid/contract/execution'
import { openTestDatabase } from './database-fixture'

const { db, close } = openTestDatabase()
const threads = new Set<string>()
afterAll(async () => {
  try {
    for (const threadID of threads) {
      await db.transaction().execute(async (tx) => {
        await tx
          .updateTable('execution.conversations')
          .set({ active_run_id: null, lease_owner: null, lease_until: null })
          .where('thread_id', '=', threadID)
          .execute()
        await tx
          .deleteFrom('execution.event_outbox')
          .where('thread_id', '=', threadID)
          .execute()
        await tx
          .deleteFrom('execution.runs')
          .where('thread_id', '=', threadID)
          .execute()
        await tx
          .deleteFrom('execution.command_inbox')
          .where('thread_id', '=', threadID)
          .execute()
        await tx
          .deleteFrom('execution.conversations')
          .where('thread_id', '=', threadID)
          .execute()
      })
    }
  } finally {
    await close()
  }
})

async function retainedHistory(bytes: number) {
  const manager = restorePiHistory(null)
  manager.appendMessage({
    role: 'user',
    content: 'M'.repeat(bytes),
    timestamp: 0,
  })
  const history = {
    header: manager.getHeader(),
    entries: manager.getEntries(),
    leafID: manager.getLeafId(),
  }
  const command = {
    version: 1,
    kind: 'start',
    commandID: crypto.randomUUID(),
    threadID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    input: {
      messageID: crypto.randomUUID(),
      text: 'Continue without replaying previous work',
    },
  } as const
  threads.add(command.threadID)
  await acceptExecutionCommand(db, command)
  const native = { provider: 'e2b', id: 'retained-history-budget-no-rpc' }
  await db
    .updateTable('execution.conversations')
    .set({
      history: sql`${JSON.stringify(history)}::jsonb`,
      native_sandbox: sql`${JSON.stringify(native)}::jsonb`,
    })
    .where('thread_id', '=', command.threadID)
    .execute()
  return { command, history, native }
}

test('oversize retained private history refuses a lease before allocation and preserves history without VM quarantine', async () => {
  const fixture = await retainedHistory(5 * 1024 * 1024)
  const before = await db
    .selectFrom('execution.conversations')
    .select([
      sql<number>`octet_length(history::text)`.as('bytes'),
      sql<number>`pg_column_size(history)`.as('stored'),
      sql<string>`md5(history::text)`.as('digest'),
    ])
    .where('thread_id', '=', fixture.command.threadID)
    .executeTakeFirstOrThrow()
  // A compressed TOAST value is not the wire/decoder budget.
  expect(before.stored).toBeLessThan(4 * 1024 * 1024)
  expect(before.bytes).toBeGreaterThan(4 * 1024 * 1024)
  expect(
    await claimExecutionRun(db, {
      ownerID: crypto.randomUUID(),
      leaseMs: 60000,
    }),
  ).toBeNull()
  const retained = await db
    .selectFrom('execution.conversations')
    .select([
      'active_run_id',
      'sandbox_recovery_required',
      'native_sandbox',
      sql<string>`md5(history::text)`.as('digest'),
    ])
    .where('thread_id', '=', fixture.command.threadID)
    .executeTakeFirstOrThrow()
  expect(retained).toEqual({
    active_run_id: null,
    sandbox_recovery_required: false,
    native_sandbox: fixture.native,
    digest: before.digest,
  })
  const run = await db
    .selectFrom('execution.runs')
    .select('status')
    .where('run_id', '=', fixture.command.runID)
    .executeTakeFirstOrThrow()
  expect(run.status).toBe('failed')
  const rows = await db
    .selectFrom('execution.event_outbox')
    .select('event')
    .where('run_id', '=', fixture.command.runID)
    .orderBy('ordinal')
    .execute()
  expect(
    rows.map(({ event }) => executionEventSchema.parse(event)),
  ).toMatchObject([{ kind: 'run-failed', reason: 'execution-error' }])
  expect(
    await claimExecutionRun(db, {
      ownerID: crypto.randomUUID(),
      leaseMs: 60000,
    }),
  ).toBeNull()
})

test('completion reports PostgreSQL-rendered history limit without VM quarantine', async () => {
  const fixture = await retainedHistory(32)
  const lease = await claimExecutionRun(db, {
    ownerID: crypto.randomUUID(),
    leaseMs: 60000,
  })
  expect(lease?.runID).toBe(fixture.command.runID)
  if (lease === null)
    throw new Error('Expected an issued history fixture lease')
  const manager = restorePiHistory(null)
  manager.appendCustomEntry(
    'opaque-provider-metadata',
    Array.from({ length: 430000 }, () => ({ x: 0 })),
  )
  const history = {
    header: manager.getHeader(),
    entries: manager.getEntries(),
    leafID: manager.getLeafId(),
  }
  const encoded = JSON.stringify(history)
  expect(Buffer.byteLength(encoded)).toBeLessThan(4 * 1024 * 1024)
  const rendered = await sql<{
    bytes: number
  }>`select octet_length((${encoded}::jsonb)::text) as bytes`.execute(db)
  expect(rendered.rows[0]?.bytes).toBeGreaterThan(4 * 1024 * 1024)
  const before = await db
    .selectFrom('execution.conversations')
    .select(sql<string>`md5(history::text)`.as('digest'))
    .where('thread_id', '=', lease.threadID)
    .executeTakeFirstOrThrow()
  expect(
    await completeExecutionRun(db, lease, {
      text: 'Must not become a completed answer',
      history,
    }),
  ).toBe('failed')
  const retained = await db
    .selectFrom('execution.conversations')
    .select([
      'active_run_id',
      'native_sandbox',
      'sandbox_recovery_required',
      sql<string>`md5(history::text)`.as('digest'),
    ])
    .where('thread_id', '=', lease.threadID)
    .executeTakeFirstOrThrow()
  expect(retained).toEqual({
    active_run_id: null,
    native_sandbox: fixture.native,
    sandbox_recovery_required: false,
    digest: before.digest,
  })
  expect(
    (
      await db
        .selectFrom('execution.runs')
        .select('status')
        .where('run_id', '=', lease.runID)
        .executeTakeFirstOrThrow()
    ).status,
  ).toBe('failed')
  const receipts = await db
    .selectFrom('execution.event_outbox')
    .select('event')
    .where('run_id', '=', lease.runID)
    .orderBy('ordinal')
    .execute()
  expect(
    receipts.map(({ event }) => executionEventSchema.parse(event).kind),
  ).toEqual(['run-started', 'run-failed'])
})

test('bounded retained canonical history is transferred unchanged under the issued lease', async () => {
  const fixture = await retainedHistory(3 * 1024 * 1024)
  const lease = await claimExecutionRun(db, {
    ownerID: crypto.randomUUID(),
    leaseMs: 60000,
  })
  expect(lease?.runID).toBe(fixture.command.runID)
  expect(lease?.history).toEqual(fixture.history)
  expect(lease?.nativeRef).toEqual(fixture.native)
})
