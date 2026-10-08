import { afterAll, afterEach, expect, test } from 'bun:test'
import type { ExecutionLease } from '../../apps/agent/src/contract'
import { acceptExecutionCommand } from '../../apps/agent/src/execution/db/command-acceptance'
import {
  claimExecutionRun,
  recoverNativeRequests,
} from '../../apps/agent/src/execution/db/execution-leases'
import { bindExecutionWrites } from '../../apps/agent/src/execution/db/run-writes'
import { executionEventSchema } from '@vid/contract/execution'
import { openTestDatabase, settleTestCleanup } from './database-fixture'

const { db, close } = openTestDatabase()
const threads = new Set<string>()
afterEach(async () => {
  await settleTestCleanup(
    [...threads].map((threadID) => async () => {
      await db.transaction().execute(async (tx) => {
        await tx
          .updateTable('execution.conversations')
          .set({ active_run_id: null, lease_owner: null, lease_until: null })
          .where('thread_id', '=', threadID)
          .execute()
        await tx.deleteFrom('execution.event_outbox').where('thread_id', '=', threadID).execute()
        await tx.deleteFrom('execution.runs').where('thread_id', '=', threadID).execute()
        await tx.deleteFrom('execution.command_inbox').where('thread_id', '=', threadID).execute()
        await tx.deleteFrom('execution.conversations').where('thread_id', '=', threadID).execute()
      })
      threads.delete(threadID)
    }),
  )
})
afterAll(close)

async function fixture(): Promise<ExecutionLease> {
  const threadID = crypto.randomUUID()
  const runID = crypto.randomUUID()
  threads.add(threadID)
  await acceptExecutionCommand(db, {
    version: 1,
    kind: 'start',
    commandID: crypto.randomUUID(),
    threadID,
    runID,
    input: { messageID: crypto.randomUUID(), text: 'Recover without dispatch' },
  })
  const lease = await claimExecutionRun(db, { ownerID: 'recovery-isolation', leaseMs: 60000 })
  if (lease?.runID !== runID) throw new Error('Expected owned run')
  return lease
}

async function state(lease: ExecutionLease) {
  const run = await db
    .selectFrom('execution.runs')
    .selectAll()
    .where('run_id', '=', lease.runID)
    .executeTakeFirstOrThrow()
  const conversation = await db
    .selectFrom('execution.conversations')
    .selectAll()
    .where('thread_id', '=', lease.threadID)
    .executeTakeFirstOrThrow()
  const events = (
    await db
      .selectFrom('execution.event_outbox')
      .select('event')
      .where('run_id', '=', lease.runID)
      .orderBy('ordinal')
      .execute()
  ).map(({ event }) => executionEventSchema.parse(event))
  return { run, conversation, events }
}

function gate() {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  return { entered, release }
}

async function whileReading(lease: ExecutionLease, change: () => Promise<unknown>) {
  const read = gate()
  const recovery = recoverNativeRequests(db, async (identity) => {
    expect(identity.runID).toBe(lease.runID)
    read.entered.resolve()
    await read.release.promise
    return { text: 'Old native final' }
  })
  const entered = await Promise.race([
    read.entered.promise.then(() => true),
    recovery.then(() => false),
  ])
  if (!entered) throw new Error('Native read did not start')
  const mutation = change()
  try {
    const completed = await Promise.race([
      mutation.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
    ])
    expect(completed).toBe(true)
  } finally {
    read.release.resolve()
    await Promise.allSettled([mutation, recovery])
  }
  await mutation
  await recovery
}

test('blocked A native read does not lock B cancellation; latest A cancellation wins', async () => {
  const leases = [await fixture(), await fixture()].sort((a, b) =>
    a.threadID.localeCompare(b.threadID),
  )
  const [a, b] = leases as [ExecutionLease, ExecutionLease]
  const read = gate()
  const recovery = recoverNativeRequests(db, async (identity) => {
    if (identity.runID === a.runID) {
      read.entered.resolve()
      await read.release.promise
    }
    return { text: 'Native final' }
  })
  await read.entered.promise
  const cancellation = Promise.all(
    [b, a].map((lease) =>
      acceptExecutionCommand(db, {
        version: 1,
        kind: 'cancel',
        commandID: crypto.randomUUID(),
        threadID: lease.threadID,
        runID: lease.runID,
      }),
    ),
  )
  try {
    expect(
      await Promise.race([
        cancellation.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
      ]),
    ).toBe(true)
  } finally {
    read.release.resolve()
    await Promise.allSettled([cancellation, recovery])
  }
  await recovery
  for (const lease of leases) {
    const { run, events } = await state(lease)
    expect(run.status).toBe('cancelled')
    expect(events.map((event) => event.kind)).toEqual(['run-started', 'run-cancelled'])
  }
})

for (const identity of ['fence', 'active_run_id', 'harness_engine', 'native_session_id'] as const) {
  test(`changed ${identity} rejects the old candidate without recovering replacement authority`, async () => {
    const lease = await fixture()
    await whileReading(lease, async () => {
      await db
        .updateTable('execution.conversations')
        .set({
          ...(identity === 'fence' ? { fence: lease.fence + 1 } : {}),
          ...(identity === 'active_run_id'
            ? { active_run_id: null, lease_owner: null, lease_until: null }
            : {}),
          ...(identity === 'harness_engine' ? { harness_engine: 'openai' } : {}),
          ...(identity === 'native_session_id' ? { native_session_id: crypto.randomUUID() } : {}),
        })
        .where('thread_id', '=', lease.threadID)
        .execute()
    })
    const { run, conversation, events } = await state(lease)
    expect(run.status).toBe('running')
    expect(run.resume_count).toBe(0)
    expect(conversation.workspace_reset_required).toBe(false)
    expect(events.map((event) => event.kind)).toEqual(['run-started'])
  })
}

test('a replacement active run is not visited or published by the old recovery pass', async () => {
  const lease = await fixture()
  const replacement = crypto.randomUUID()
  await whileReading(lease, async () => {
    await acceptExecutionCommand(db, {
      version: 1,
      kind: 'start',
      commandID: crypto.randomUUID(),
      threadID: lease.threadID,
      runID: replacement,
      input: { messageID: crypto.randomUUID(), text: 'New authority' },
    })
    await db.transaction().execute(async (tx) => {
      await tx
        .updateTable('execution.conversations')
        .set({ active_run_id: replacement })
        .where('thread_id', '=', lease.threadID)
        .execute()
      await tx
        .updateTable('execution.runs')
        .set({ status: 'running' })
        .where('run_id', '=', replacement)
        .execute()
    })
  })
  const { run, conversation, events } = await state(lease)
  expect(run.status).toBe('running')
  expect(conversation.active_run_id).toBe(replacement)
  expect(events.map((event) => event.kind)).toEqual(['run-started'])
  const newer = await db
    .selectFrom('execution.runs')
    .select(['status', 'resume_count'])
    .where('run_id', '=', replacement)
    .executeTakeFirstOrThrow()
  expect(newer).toEqual({ status: 'running', resume_count: 0 })
  expect(
    await db
      .selectFrom('execution.event_outbox')
      .select('event_id')
      .where('run_id', '=', replacement)
      .execute(),
  ).toHaveLength(0)
})

for (const flag of [
  'sandbox_recovery_required',
  'workspace_transition_pending',
  'legacy_import_required',
] as const) {
  test(`latest ${flag} wins over a previously read native final`, async () => {
    const lease = await fixture()
    await whileReading(lease, async () => {
      await db
        .updateTable('execution.conversations')
        .set({ [flag]: true })
        .where('thread_id', '=', lease.threadID)
        .execute()
    })
    const { run, conversation, events } = await state(lease)
    expect(run.status).toBe('failed')
    expect(conversation[flag]).toBe(true)
    if (flag !== 'legacy_import_required') expect(conversation.sandbox_recovery_required).toBe(true)
    expect(events.map((event) => event.kind)).toEqual(['run-started', 'run-failed'])
  })
}

test('a latest terminal is never resurrected by a native final', async () => {
  const lease = await fixture()
  await whileReading(lease, () => bindExecutionWrites(db).cancel(lease))
  const { run, events } = await state(lease)
  expect(run.status).toBe('cancelled')
  expect(events.map((event) => event.kind)).toEqual(['run-started', 'run-cancelled'])
})

test('no-final lookup crossing deadline fails without consuming resume allowance', async () => {
  const lease = await fixture()
  await db
    .updateTable('execution.runs')
    .set({ deadline_at: new Date(Date.now() + 200) })
    .where('run_id', '=', lease.runID)
    .execute()
  await recoverNativeRequests(db, async () => {
    await Bun.sleep(300)
    return undefined
  })
  const { run, events } = await state(lease)
  expect(run.status).toBe('failed')
  expect(run.resume_count).toBe(0)
  expect(events[1]).toMatchObject({ kind: 'run-failed', reason: 'interrupted' })
})

test('a read failure on B cannot roll back the native final committed for A', async () => {
  const leases = [await fixture(), await fixture()].sort((a, b) =>
    a.threadID.localeCompare(b.threadID),
  )
  const [a, b] = leases as [ExecutionLease, ExecutionLease]
  const error = await recoverNativeRequests(db, async (identity) => {
    if (identity.runID === b.runID) throw new Error('Initialized native state missing')
    return { text: 'Committed A' }
  }).then(
    () => undefined,
    (cause: unknown) => cause,
  )
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe('Initialized native state missing')
  expect((await state(a)).run.status).toBe('completed')
  expect((await state(b)).run.status).toBe('running')
  expect((await state(a)).events.map((event) => event.kind)).toEqual([
    'run-started',
    'run-completed',
  ])
})

test('B quarantine committed during A read forbids inspecting B native state', async () => {
  const leases = [await fixture(), await fixture()].sort((a, b) =>
    a.threadID.localeCompare(b.threadID),
  )
  const [a, b] = leases as [ExecutionLease, ExecutionLease]
  await recoverNativeRequests(db, async (identity) => {
    if (identity.runID === b.runID) throw new Error('Quarantined native state must not be read')
    await db
      .updateTable('execution.conversations')
      .set({ workspace_transition_pending: true })
      .where('thread_id', '=', b.threadID)
      .execute()
    return { text: 'A final' }
  })
  expect((await state(a)).run.status).toBe('completed')
  const { run, conversation } = await state(b)
  expect(run.status).toBe('failed')
  expect(conversation.workspace_transition_pending).toBe(true)
  expect(conversation.sandbox_recovery_required).toBe(true)
})
