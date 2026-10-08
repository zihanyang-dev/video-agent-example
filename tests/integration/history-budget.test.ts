import { afterEach, afterAll, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { acceptExecutionCommand } from '../../apps/agent/src/execution/db/command-acceptance'
import {
  claimExecutionRun,
  recoverNativeRequests,
} from '../../apps/agent/src/execution/db/execution-leases'
import { bindExecutionWrites } from '../../apps/agent/src/execution/db/run-writes'
import { executionEventSchema, type StartCommand } from '@vid/contract/execution'
import type { ExecutionLease } from '../../apps/agent/src/contract'
import { clearOwnedExecutionThread, openTestDatabase } from './database-fixture'

const { db, close } = openTestDatabase()
const threads = new Set<string>()
afterEach(async () => {
  for (const threadID of threads) {
    await clearOwnedExecutionThread(db, threadID)
    threads.delete(threadID)
  }
})
afterAll(close)

async function accepted(threadID: string = crypto.randomUUID()) {
  threads.add(threadID)
  const command: StartCommand = {
    version: 1,
    kind: 'start',
    commandID: crypto.randomUUID(),
    threadID,
    runID: crypto.randomUUID(),
    input: { messageID: crypto.randomUUID(), text: 'Continue native state' },
  }
  expect(await acceptExecutionCommand(db, command)).toBe('accepted')
  return command
}
async function claim(command: StartCommand) {
  const lease = await claimExecutionRun(db, {
    ownerID: crypto.randomUUID(),
    leaseMs: 60000,
    requestTimeoutMs: 120000,
  })
  if (lease === null || lease.runID !== command.runID)
    throw new Error('Expected owned native request')
  return lease
}
async function state(lease: ExecutionLease) {
  return await db
    .selectFrom('execution.conversations')
    .select([
      'sandbox_recovery_required',
      'workspace_reset_required',
      'active_run_id',
      'native_session_id',
    ])
    .where('thread_id', '=', lease.threadID)
    .executeTakeFirstOrThrow()
}
async function events(runID: string) {
  return (
    await db
      .selectFrom('execution.event_outbox')
      .select('event')
      .where('run_id', '=', runID)
      .orderBy('ordinal')
      .execute()
  ).map((row) => executionEventSchema.parse(row.event))
}

// Archived fixtures preserve provenance for offline import. They are not native SDK state.
async function archived(command: StartCommand, blocked: boolean) {
  const legacy = {
    header: { type: 'session', version: 3 },
    entries: [
      { type: 'custom', customType: 'opaque-provider-metadata', data: 'M'.repeat(5 * 1024 * 1024) },
    ],
    leafID: null,
  }
  const native = { provider: 'e2b', id: 'legacy-workspace-no-rpc' }
  await db
    .updateTable('execution.conversations')
    .set({
      legacy_history: sql`${JSON.stringify(legacy)}::jsonb`,
      legacy_import_required: blocked,
      native_sandbox: sql`${JSON.stringify(native)}::jsonb`,
    })
    .where('thread_id', '=', command.threadID)
    .execute()
  return native
}
async function archiveDigest(threadID: string) {
  return await db
    .selectFrom('execution.conversations')
    .select([
      sql<string>`md5(legacy_history::text)`.as('digest'),
      sql<number>`octet_length(legacy_history::text)`.as('bytes'),
      'native_sandbox',
      'sandbox_recovery_required',
    ])
    .where('thread_id', '=', threadID)
    .executeTakeFirstOrThrow()
}

test('legacy import gate rejects ordinary admission without erasing archived metadata or quarantining workspace', async () => {
  const command = await accepted()
  const native = await archived(command, true)
  const before = await archiveDigest(command.threadID)
  expect(before.bytes).toBeGreaterThan(4 * 1024 * 1024)
  expect(await claimExecutionRun(db, { ownerID: 'ordinary-worker', leaseMs: 60000 })).toBeNull()
  expect(await archiveDigest(command.threadID)).toEqual(before)
  expect(before.native_sandbox).toEqual(native)
  expect(before.sandbox_recovery_required).toBe(false)
  expect(await events(command.runID)).toMatchObject([
    { kind: 'run-failed', reason: 'execution-error' },
  ])
})

test('offline-imported archive size neither caps native claims nor transfers private data into completion', async () => {
  const command = await accepted()
  // Represents an operator-confirmed offline import: retained archive is no longer replay authority.
  const native = await archived(command, false)
  const before = await archiveDigest(command.threadID)
  const lease = await claim(command)
  expect(lease).not.toHaveProperty('history')
  expect(lease.nativeRef).toEqual(native)
  const writes = bindExecutionWrites(db)
  expect(await writes.complete(lease, { text: 'Public answer' })).toBe('completed')
  expect(await archiveDigest(command.threadID)).toEqual(before)
  expect(JSON.stringify(await events(command.runID))).not.toContain('opaque-provider-metadata')
  const next = await claim(await accepted(command.threadID))
  expect(next.nativeSessionID).toBe(lease.nativeSessionID)
  expect(next).not.toHaveProperty('history')
  expect(await writes.cancel(next)).toBe('cancelled')
})

test('startup continuation preserves model reservations, original deadline, native identity, and two-resume budget', async () => {
  const command = await accepted()
  let lease = await claim(command)
  const original = lease
  const writes = bindExecutionWrites(db)
  for (let count = 0; count < 14; count++) expect(await writes.reserveModel(lease)).toBe('allowed')
  for (let resume = 1; resume <= 2; resume++) {
    // No live worker or guest writer exists in this fixture. Production must first hold its kernel lock.
    await recoverNativeRequests(db)
    expect(await writes.reserveModel(lease)).toBe('lost')
    lease = await claim(command)
    expect(lease.nativeSessionID).toBe(original.nativeSessionID)
    expect(lease.deadlineAt).toEqual(original.deadlineAt)
    expect(lease.restoring).toBe(true)
    expect(lease.restoreWorkspace).toBe(true)
    expect(lease.fence).toBeGreaterThan(original.fence)
    const run = await db
      .selectFrom('execution.runs')
      .select(['model_call_count', 'resume_count'])
      .where('run_id', '=', command.runID)
      .executeTakeFirstOrThrow()
    expect(run).toEqual({ model_call_count: 14, resume_count: resume })
  }
  await recoverNativeRequests(db)
  expect((await events(command.runID)).map((event) => event.kind)).toEqual([
    'run-started',
    'run-failed',
  ])
  expect((await events(command.runID)).at(-1)).toMatchObject({ reason: 'interrupted' })
  expect(await state(lease)).toMatchObject({
    active_run_id: null,
    sandbox_recovery_required: false,
    workspace_reset_required: true,
  })
  const next = await claim(await accepted(command.threadID))
  expect(next.restoreWorkspace).toBe(true)
  expect(await writes.saveSandbox(next, { provider: 'e2b', id: 'cold-settled-native' })).toBe(true)
  expect((await state(next)).workspace_reset_required).toBe(false)
  expect(await writes.cancel(next)).toBe('cancelled')
})

for (const exhausted of ['deadline', 'model calls'] as const) {
  test(`${exhausted} exhaustion prevents continuation but does not quarantine a known workspace`, async () => {
    const command = await accepted()
    const lease = await claim(command)
    const writes = bindExecutionWrites(db)
    if (exhausted === 'model calls') {
      const reservations = await Promise.all(
        Array.from({ length: 20 }, () => writes.reserveModel(lease)),
      )
      expect(reservations.filter((decision) => decision === 'allowed')).toHaveLength(16)
      expect(reservations.filter((decision) => decision === 'limit')).toHaveLength(4)
    } else {
      await db
        .updateTable('execution.runs')
        .set({ deadline_at: sql`clock_timestamp() - interval '1 second'` })
        .where('run_id', '=', command.runID)
        .execute()
      expect(await writes.reserveModel(lease)).toBe('limit')
      expect(await writes.beginEffect(lease)).toBe('limit')
    }
    await recoverNativeRequests(db)
    expect((await events(command.runID)).at(-1)).toMatchObject({
      kind: 'run-failed',
      reason: 'interrupted',
    })
    expect(await state(lease)).toMatchObject({
      sandbox_recovery_required: false,
      workspace_reset_required: true,
    })
    const next = await claim(await accepted(command.threadID))
    expect(next.restoreWorkspace).toBe(true)
    expect(await writes.cancel(next)).toBe('cancelled')
  })
}

for (const uncertainty of ['effect', 'workspace transition'] as const) {
  test(`unsettled ${uncertainty} blocks native replay and terminalizes queued work with quarantine`, async () => {
    const command = await accepted()
    const lease = await claim(command)
    const queued = await accepted(command.threadID)
    const writes = bindExecutionWrites(db)
    if (uncertainty === 'effect') expect(await writes.beginEffect(lease)).toBe('allowed')
    else {
      expect(await writes.beginWorkspaceTransition(lease)).toBe(true)
      expect(await writes.reserveModel(lease)).toBe('recovery-required')
      expect(await writes.checkpoint(lease)).toBe(false)
    }
    await recoverNativeRequests(db)
    expect(await state(lease)).toMatchObject({
      active_run_id: null,
      sandbox_recovery_required: true,
      workspace_reset_required: true,
    })
    for (const runID of [command.runID, queued.runID])
      expect((await events(runID)).at(-1)).toMatchObject({
        kind: 'run-failed',
        reason: 'sandbox-recovery-required',
      })
    expect(await writes.checkpoint(lease)).toBe(false)
    expect(await claimExecutionRun(db, { ownerID: 'unsafe-replay', leaseMs: 60000 })).toBeNull()
  })
}

test('durable checkpoint removes effect uncertainty before startup continuation', async () => {
  const command = await accepted()
  const lease = await claim(command)
  const writes = bindExecutionWrites(db)
  expect(await writes.beginEffect(lease)).toBe('allowed')
  expect(await writes.checkpoint(lease)).toBe(true)
  await recoverNativeRequests(db)
  const restored = await claim(command)
  expect(restored.restoring).toBe(true)
  expect((await state(restored)).sandbox_recovery_required).toBe(false)
  expect(await writes.complete(restored, { text: 'Checkpointed continuation' })).toBe('completed')
})

test('model reservation samples database deadline after waiting for the conversation lock', async () => {
  const command = await accepted()
  const lease = await claim(command)
  await db
    .updateTable('execution.runs')
    .set({ deadline_at: sql`clock_timestamp() + interval '500 milliseconds'` })
    .where('run_id', '=', command.runID)
    .execute()
  const blocked = await db.transaction().execute(async (tx) => {
    await tx
      .selectFrom('execution.conversations')
      .select('thread_id')
      .where('thread_id', '=', lease.threadID)
      .forUpdate()
      .execute()
    const reservation = bindExecutionWrites(db).reserveModel(lease)
    await sql`select pg_sleep(1)`.execute(tx)
    return { reservation }
  })
  expect(await blocked.reservation).toBe('limit')
  const run = await db
    .selectFrom('execution.runs')
    .select('model_call_count')
    .where('run_id', '=', command.runID)
    .executeTakeFirstOrThrow()
  expect(run.model_call_count).toBe(0)
  expect((await state(lease)).sandbox_recovery_required).toBe(false)
  expect(await bindExecutionWrites(db).fail(lease, 'interrupted')).toBe('failed')
})
