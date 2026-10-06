import { acceptExecutionCommand } from '../../apps/agent/src/db/command-acceptance'
import {
  claimExecutionRun,
  renewExecutionLease,
} from '../../apps/agent/src/db/execution-leases'
import {
  appendExecutionText,
  completeExecutionRun,
  failExecutionRun,
  cancelExecutionRun,
  bindExecutionWrites,
  quarantineSandbox,
} from '../../apps/agent/src/db/run-writes'
import { afterAll, expect, test } from 'bun:test'
import { executionEventSchema } from '@vid/contract/execution'
import { sql } from 'kysely'
import {
  executeRun,
  type AgentHarness,
  type ExecutionLease,
  type ExecutionWrites,
  type SandboxSessionPort,
} from '../../apps/agent/src/execute-run'
import { openTestDatabase } from './database-fixture'

const { db, close } = openTestDatabase()
const ownedThreads = new Set<string>()
afterAll(async () => {
  try {
    for (const threadID of ownedThreads) {
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function claimFixture(leaseMs: number) {
  const command = {
    version: 1,
    kind: 'start',
    commandID: crypto.randomUUID(),
    threadID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    input: { messageID: crypto.randomUUID(), text: 'hello' },
  } as const
  ownedThreads.add(command.threadID)
  await acceptExecutionCommand(db, command)
  const lease = await claimExecutionRun(db, {
    ownerID: crypto.randomUUID(),
    leaseMs,
  })
  if (lease === null || lease.runID !== command.runID)
    throw new Error('Expected fixture lease')
  return lease
}

function pipeline(turnError: boolean) {
  const started = deferred<Parameters<AgentHarness['turn']>[0]>()
  const end = deferred<void>()
  const closing = deferred<void>()
  const closed = deferred<void>()
  const sandbox: SandboxSessionPort = {
    nativeRef: { provider: 'e2b', id: 'fixture-native' },

    readBytes: async () => new Uint8Array(),
    writeBytes: async () => {},
    execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    read: async () => '',
    write: async () => {},
    close: async () => {
      closing.resolve()
      await closed.promise
    },
  }
  const harness: AgentHarness = {
    turn: async (input) => {
      started.resolve(input)
      await end.promise
      if (turnError) throw new Error('turn failed')
      input.signal.throwIfAborted()
      return { text: 'answer', history: ['must not commit'] }
    },
  }
  return { started, end, closing, closed, sandbox, harness }
}

async function fixture(
  turnError = false,
  writes: ExecutionWrites = bindExecutionWrites(db),
) {
  const leaseMs = 600
  const lease = await claimFixture(leaseMs)
  const { started, end, closing, closed, sandbox, harness } =
    pipeline(turnError)
  const shutdown = new AbortController()
  const run = executeRun(
    lease,
    { writes, harness, openSandbox: async () => sandbox },
    {
      leaseMs,
      pollMs: 25,
      signal: shutdown.signal,
    },
  )
  const input = await started.promise
  const aborted = deferred<void>()
  input.signal.addEventListener('abort', () => aborted.resolve(), {
    once: true,
  })
  async function cancel() {
    await acceptExecutionCommand(db, {
      version: 1,
      kind: 'cancel',
      commandID: crypto.randomUUID(),
      threadID: lease.threadID,
      runID: lease.runID,
    })
    await aborted.promise
  }
  return {
    lease,
    leaseMs,
    input,
    end,
    closing,
    closed,
    sandbox,
    shutdown,
    run,
    cancel,
    snapshot: () => snapshot(lease),
  }
}

async function snapshot(lease: ExecutionLease) {
  const run = await db
    .selectFrom('execution.runs')
    .select(['status', 'cancel_requested'])
    .where('run_id', '=', lease.runID)
    .executeTakeFirstOrThrow()
  const conversation = await db
    .selectFrom('execution.conversations')
    .select(['history', 'active_run_id'])
    .where('thread_id', '=', lease.threadID)
    .executeTakeFirstOrThrow()
  const rows = await db
    .selectFrom('execution.event_outbox')
    .select('event')
    .where('run_id', '=', lease.runID)
    .orderBy('ordinal')
    .execute()
  return {
    run,
    conversation,
    events: rows.map((row) => executionEventSchema.parse(row.event)),
  }
}

for (const reason of ['cancel', 'error', 'shutdown'] as const) {
  test(`${reason} retains fenced ownership through slow turn and sandbox settlement`, async () => {
    const f = await fixture(reason === 'error')
    try {
      if (reason === 'cancel') await f.cancel()
      else if (reason === 'shutdown') f.shutdown.abort()
      else f.end.resolve()
      // Harness settlement can exceed a lease after cancellation or shutdown.
      if (reason !== 'error') {
        await Bun.sleep(f.leaseMs * 2)
        expect(
          await claimExecutionRun(db, {
            ownerID: 'contender',
            leaseMs: f.leaseMs,
          }),
        ).toBeNull()
        expect((await f.snapshot()).run.status).toBe('running')
      }
      f.end.resolve()
      await f.closing.promise
      await Bun.sleep(f.leaseMs * 2)
      expect(
        await claimExecutionRun(db, {
          ownerID: 'contender',
          leaseMs: f.leaseMs,
        }),
      ).toBeNull()
      expect((await f.snapshot()).run.status).toBe('running')
    } finally {
      f.end.resolve()
      f.closed.resolve()
      await f.run
    }
    expect(await f.run).toBe(reason === 'cancel' ? 'cancelled' : 'failed')
    const state = await f.snapshot()
    expect(state.conversation.history).toEqual([])
    expect(state.conversation.active_run_id).toBeNull()
    expect(state.events.map((event) => event.kind)).toEqual([
      'run-started',
      reason === 'cancel' ? 'run-cancelled' : 'run-failed',
    ])
  })
}

test('cancelled remote cleanup failure records execution-error, not cancellation success', async () => {
  const f = await fixture()
  f.sandbox.close = async () => {
    throw new Error('remote delete failed')
  }
  await f.cancel()
  f.end.resolve()
  expect(await f.run).toBe('failed')
  const state = await f.snapshot()
  expect(state.run).toEqual({ status: 'failed', cancel_requested: true })
  expect(state.conversation).toEqual({ history: [], active_run_id: null })
  expect(state.events.map((event) => event.kind)).toEqual([
    'run-started',
    'run-failed',
  ])
  expect(state.events[1]).toMatchObject({ reason: 'execution-error' })
})

test('database cancellation wins over shutdown interruption', async () => {
  const cancelled = deferred<void>()
  const writes = bindExecutionWrites(db)
  const f = await fixture(false, {
    ...writes,
    renew: async (lease, leaseMs) => {
      const authority = await writes.renew(lease, leaseMs)
      if (authority === 'cancel') cancelled.resolve()
      return authority
    },
  })
  f.shutdown.abort()
  await acceptExecutionCommand(db, {
    version: 1,
    kind: 'cancel',
    commandID: crypto.randomUUID(),
    threadID: f.lease.threadID,
    runID: f.lease.runID,
  })
  // Observe cancellation while the interrupted harness remains unsettled.
  await cancelled.promise
  f.end.resolve()
  f.closed.resolve()
  expect(await f.run).toBe('cancelled')
  expect((await f.snapshot()).run).toEqual({
    status: 'cancelled',
    cancel_requested: true,
  })
})

test('true fence loss during cleanup excludes text, history and terminal writes', async () => {
  const f = await fixture()
  await f.cancel()
  f.end.resolve()
  await f.closing.promise
  await db
    .updateTable('execution.conversations')
    .set({ fence: sql`fence + 1` })
    .where('thread_id', '=', f.lease.threadID)
    .execute()
  expect(await renewExecutionLease(db, f.lease, f.leaseMs)).toBe('lost')
  expect(await appendExecutionText(db, f.lease, 'stale')).toBe(false)
  expect(
    await completeExecutionRun(db, f.lease, {
      text: 'stale',
      history: ['stale'],
    }),
  ).toBe(false)
  expect(await failExecutionRun(db, f.lease, 'execution-error')).toBe(false)
  expect(await cancelExecutionRun(db, f.lease)).toBe(false)
  f.closed.resolve()
  expect(await f.run).toBe('lost')
  const state = await f.snapshot()
  expect(state.events.map((event) => event.kind)).toEqual(['run-started'])
  expect(state.conversation.history).toEqual([])
  // Release only this deliberately fenced fixture, not another worker's rows.
  await db
    .updateTable('execution.conversations')
    .set({ lease_until: sql`clock_timestamp() - interval '1 second'` })
    .where('thread_id', '=', f.lease.threadID)
    .execute()
  expect(
    await claimExecutionRun(db, { ownerID: 'reaper', leaseMs: f.leaseMs }),
  ).toBeNull()
})

test('cancellation racing shutdown terminal retains database cancellation authority', async () => {
  const f = await fixture(false, {
    ...bindExecutionWrites(db),
    fail: async (lease, failure) => {
      await acceptExecutionCommand(db, {
        version: 1,
        kind: 'cancel',
        commandID: crypto.randomUUID(),
        threadID: lease.threadID,
        runID: lease.runID,
      })
      return await failExecutionRun(db, lease, failure)
    },
  })
  f.shutdown.abort()
  f.end.resolve()
  f.closed.resolve()
  expect(await f.run).toBe('cancelled')
  expect((await f.snapshot()).run).toEqual({
    status: 'cancelled',
    cancel_requested: true,
  })
})

test('late old-fence quarantine aborts the new paid turn and keeps its lease through settlement', async () => {
  const old = await claimFixture(60000)
  const nativeRef = { provider: 'e2b', id: 'fixture-native' }
  const writes = bindExecutionWrites(db)
  const committed = deferred<void>()
  const lostAck = deferred<void>()
  const oldSandbox = pipeline(false)
  oldSandbox.closed.resolve()
  let oldCompletions = 0
  const oldRun = executeRun(
    old,
    {
      writes: {
        ...writes,
        complete: async (lease, completion) => {
          oldCompletions++
          expect(await writes.complete(lease, completion)).toBe(true)
          committed.resolve()
          // Hold the lost acknowledgement until the next fence starts spending.
          await lostAck.promise
          throw new Error('completion ACK lost')
        },
      },
      openSandbox: async () => oldSandbox.sandbox,
      harness: {
        turn: async () => ({ text: 'committed', history: ['committed'] }),
      },
    },
    { leaseMs: 60000, pollMs: 60000, signal: new AbortController().signal },
  ).catch((error: unknown) => error)
  await committed.promise
  const command = {
    version: 1,
    kind: 'start',
    commandID: crypto.randomUUID(),
    threadID: old.threadID,
    runID: crypto.randomUUID(),
    input: { messageID: crypto.randomUUID(), text: 'next' },
  } as const
  await acceptExecutionCommand(db, command)
  const active = await claimExecutionRun(db, {
    ownerID: 'new-owner',
    leaseMs: 600,
  })
  if (active === null) throw new Error('Expected new lease')
  expect(active.nativeRef).toEqual(nativeRef)
  const f = pipeline(false)
  let turns = 0
  let toolCalls = 0
  f.sandbox.read = async () => {
    toolCalls++
    return 'unsafe'
  }
  const run = executeRun(
    active,
    {
      writes,
      openSandbox: async () => f.sandbox,
      harness: {
        turn: async (input) => {
          turns++
          return await f.harness.turn(input)
        },
      },
    },
    { leaseMs: 600, pollMs: 25, signal: new AbortController().signal },
  )
  const input = await f.started.promise
  const aborted = deferred<void>()
  input.signal.addEventListener('abort', () => aborted.resolve(), {
    once: true,
  })
  if (input.signal.aborted) aborted.resolve()
  try {
    lostAck.resolve()
    expect(await oldRun).toEqual(new Error('completion ACK lost'))
    expect(oldCompletions).toBe(1)
    expect((await snapshot(old)).events).toMatchObject([
      { kind: 'run-started' },
      { kind: 'run-completed', text: 'committed' },
    ])
    await aborted.promise
    expect(input.signal.aborted).toBe(true)
    const toolOutcome = await input.tools
      .read({ path: '/unsafe', signal: input.signal })
      .catch((error: unknown) => error)
    expect(toolOutcome).toBe(input.signal.reason)
    expect(toolCalls).toBe(0)
    input.onText('unsafe')
    await Bun.sleep(1200)
    expect(
      await claimExecutionRun(db, { ownerID: 'contender', leaseMs: 600 }),
    ).toBeNull()
    expect((await snapshot(active)).run.status).toBe('running')
    f.end.resolve()
    await f.closing.promise
    await Bun.sleep(1200)
    expect(
      await claimExecutionRun(db, { ownerID: 'contender', leaseMs: 600 }),
    ).toBeNull()
    expect((await snapshot(active)).run.status).toBe('running')
  } finally {
    lostAck.resolve()
    f.end.resolve()
    f.closed.resolve()
    await oldRun
    await run
  }
  expect(await run).toBe('failed')
  expect(turns).toBe(1)
  const state = await snapshot(active)
  expect(state.conversation).toEqual({
    history: ['committed'],
    active_run_id: null,
  })
  expect(state.events).toMatchObject([
    { kind: 'run-started' },
    { kind: 'run-failed', reason: 'execution-error' },
  ])
})

test('SQL decides racing cancellation once without reauthorization or quarantine', async () => {
  let terminalAttempted = false
  let completions = 0
  let quarantines = 0
  const writes = bindExecutionWrites(db)
  const f = await fixture(false, {
    ...writes,
    renew: async (lease, leaseMs) => {
      if (terminalAttempted) throw new Error('renewal ACK lost')
      return await writes.renew(lease, leaseMs)
    },
    complete: async (lease, completion) => {
      completions++
      terminalAttempted = true
      await acceptExecutionCommand(db, {
        version: 1,
        kind: 'cancel',
        commandID: crypto.randomUUID(),
        threadID: lease.threadID,
        runID: lease.runID,
      })
      return await completeExecutionRun(db, lease, completion)
    },
    quarantine: async (lease, reason) => {
      quarantines++
      await quarantineSandbox(db, lease, reason)
    },
  })
  f.end.resolve()
  f.closed.resolve()
  expect(await f.run).toBe('cancelled')
  expect(completions).toBe(1)
  expect(quarantines).toBe(0)
  const state = await f.snapshot()
  expect(state.conversation).toEqual({ history: [], active_run_id: null })
  expect(state.run).toEqual({ status: 'cancelled', cancel_requested: true })
  expect(state.events).toMatchObject([
    { kind: 'run-started' },
    { kind: 'run-cancelled' },
  ])
  const recovery = await db
    .selectFrom('execution.conversations')
    .select('sandbox_recovery_required')
    .where('thread_id', '=', f.lease.threadID)
    .executeTakeFirstOrThrow()
  expect(recovery.sandbox_recovery_required).toBe(false)
})
