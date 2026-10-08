import { acceptExecutionCommand } from '../../apps/agent/src/execution/db/command-acceptance'
import {
  claimExecutionRun,
  renewExecutionLease,
  recoverNativeRequests,
} from '../../apps/agent/src/execution/db/execution-leases'
import {
  appendExecutionText,
  completeExecutionRun,
  failExecutionRun,
  cancelExecutionRun,
  saveNativeSandbox,
  quarantineSandbox,
  bindExecutionWrites,
} from '../../apps/agent/src/execution/db/run-writes'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, test } from 'bun:test'
import {
  executionEventSchema,
  startCommandSchema,
  type StartCommand,
} from '@vid/contract/execution'
import { sql } from 'kysely'
import type { ExecutionLease } from '../../apps/agent/src/contract.ts'
import { createPiHarness } from '../../apps/agent/src/harness/pi/adapter'
import { clearOwnedExecutionThread, openTestDatabase } from './database-fixture'
import { modelStream } from './model-stream-fixture'

const { db, close } = openTestDatabase()
const ownedThreads = new Set<string>()
afterEach(async () => {
  for (const threadID of ownedThreads) {
    await clearOwnedExecutionThread(db, threadID)
    ownedThreads.delete(threadID)
  }
})
afterAll(close)

function start(threadID: string = crypto.randomUUID()): StartCommand {
  ownedThreads.add(threadID.toLowerCase())
  return {
    version: 1,
    kind: 'start',
    commandID: crypto.randomUUID(),
    threadID,
    runID: crypto.randomUUID(),
    input: { messageID: crypto.randomUUID(), text: 'Hello' },
  }
}
function cancellation(command: StartCommand) {
  return {
    version: 1,
    kind: 'cancel',
    commandID: crypto.randomUUID(),
    threadID: command.threadID,
    runID: command.runID,
  } as const
}
async function claim(): Promise<ExecutionLease> {
  const lease = await claimExecutionRun(db, {
    ownerID: 'worker',
    leaseMs: 60000,
  })
  if (lease === null) throw new Error('Expected a queued lease')
  return lease
}
for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
  for (const stale of [false, true]) {
    test(`bound ${terminal} receipt reports ${stale ? 'lost ownership' : 'the committed outcome'}`, async () => {
      const command = start()
      expect(await acceptExecutionCommand(db, command)).toBe('accepted')
      const claimed = await claim()
      const lease = stale ? { ...claimed, fence: claimed.fence + 1 } : claimed
      const writes = bindExecutionWrites(db)
      const outcome =
        terminal === 'completed'
          ? await writes.complete(lease, {
              text: 'answer',
            })
          : terminal === 'failed'
            ? await writes.fail(lease, 'execution-error')
            : await writes.cancel(lease)
      expect(outcome).toBe(stale ? 'lost' : terminal)
      const run = await db
        .selectFrom('execution.runs')
        .select('status')
        .where('run_id', '=', claimed.runID)
        .executeTakeFirstOrThrow()
      expect(run.status).toBe(stale ? 'running' : terminal)
      const receipts = await events(claimed.runID)
      expect(receipts.map((event) => event.kind)).toEqual(
        stale ? ['run-started'] : ['run-started', `run-${terminal}`],
      )
    })
  }
}

for (const request of ['complete', 'interrupt'] as const) {
  test(`bound ${request} preserves cancellation chosen under the SQL lock`, async () => {
    const command = start()
    await acceptExecutionCommand(db, command)
    const lease = await claim()
    await acceptExecutionCommand(db, cancellation(command))
    const writes = bindExecutionWrites(db)
    const outcome =
      request === 'complete'
        ? await writes.complete(lease, {
            text: 'discard',
          })
        : await writes.fail(lease, 'interrupted')
    expect(outcome).toBe('cancelled')
    expect((await events(lease.runID)).map((event) => event.kind)).toEqual([
      'run-started',
      'run-cancelled',
    ])
    const conversation = await db
      .selectFrom('execution.conversations')
      .select('legacy_history')
      .where('thread_id', '=', lease.threadID)
      .executeTakeFirstOrThrow()
    expect(conversation.legacy_history).toEqual([])
  })
}

test('bound completion refuses uncheckpointed effects instead of claiming completion', async () => {
  await acceptExecutionCommand(db, start())
  const lease = await claim()
  const writes = bindExecutionWrites(db)
  expect(await writes.beginEffect(lease)).toBe('allowed')
  expect(await writes.complete(lease, { text: 'discard' })).toBe('failed')
  expect((await events(lease.runID)).at(-1)).toMatchObject({
    kind: 'run-failed',
    reason: 'sandbox-recovery-required',
  })
  const conversation = await db
    .selectFrom('execution.conversations')
    .select(['legacy_history', 'sandbox_recovery_required'])
    .where('thread_id', '=', lease.threadID)
    .executeTakeFirstOrThrow()
  expect(conversation.legacy_history).toEqual([])
  expect(conversation.sandbox_recovery_required).toBe(true)
})

async function events(runID: string) {
  const rows = await db
    .selectFrom('execution.event_outbox')
    .selectAll()
    .where('run_id', '=', runID)
    .orderBy('ordinal')
    .execute()
  return rows.map((row) => {
    const event = executionEventSchema.parse(row.event)
    expect(event).toMatchObject({
      eventID: row.event_id,
      threadID: row.thread_id,
      runID: row.run_id,
    })
    return event
  })
}
async function storedAssistantID(runID: string) {
  const run = await db
    .selectFrom('execution.runs')
    .select('assistant_message_id')
    .where('run_id', '=', runID)
    .executeTakeFirstOrThrow()
  return run.assistant_message_id
}

async function expire(lease: ExecutionLease) {
  await db
    .updateTable('execution.conversations')
    .set({ lease_until: sql`clock_timestamp() - interval '1 second'` })
    .where('thread_id', '=', lease.threadID)
    .execute()
}

function piProviderFixture() {
  const requests: unknown[] = []
  const answers = ['First answer', 'Second answer']
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      const text = answers.shift()
      if (text === undefined) return new Response('Unexpected request', { status: 500 })
      const chunks = [
        { delta: { role: 'assistant', content: text }, finish_reason: null },
        { delta: {}, finish_reason: 'stop' },
      ]
      return modelStream(
        chunks.map((chunk) => ({
          id: 'fixture',
          object: 'chat.completion.chunk',
          model: 'fixture-model',
          choices: [{ index: 0, ...chunk }],
        })),
      )
    },
  })
  const options = {
    baseURL: `http://127.0.0.1:${provider.port}/v1`,
    key: 'fixture-only-key',
    modelID: 'fixture-model',
    contextWindow: 16384,
    maxOutputTokens: 512,
    reasoning: false,
    input: ['text'] as const,
    systemPrompt: 'Use only assigned sandbox tools.',
  }
  const input = {
    signal: AbortSignal.timeout(10000),
    onText: () => {},
    tools: {
      async execute() {
        throw new Error('Unexpected sandbox execute')
      },
      async read() {
        throw new Error('Unexpected sandbox read')
      },
      async write() {
        throw new Error('Unexpected sandbox write')
      },
    },
  }
  return { provider, requests, options, input }
}

test('native Pi storage continues the same session without SQL private-history transfer', async () => {
  const first = start()
  const second = start(first.threadID)
  const { provider, requests, options, input } = piProviderFixture()
  const statePath = await mkdtemp(join(tmpdir(), 'owned-native-pi-'))
  try {
    await acceptExecutionCommand(db, first)
    const lease = await claim()
    expect(lease.runID).toBe(first.runID)
    expect(lease).not.toHaveProperty('history')
    const retained = await db
      .selectFrom('execution.runs')
      .select(['command_id', 'message_id'])
      .where('run_id', '=', first.runID)
      .executeTakeFirstOrThrow()
    expect(retained).toEqual({ command_id: first.commandID, message_id: first.input.messageID })
    const run = async (assigned: ExecutionLease) => {
      const writes = bindExecutionWrites(db)
      return await createPiHarness({ ...options, statePath }).run({
        ...input,
        engine: assigned.engine,
        threadID: assigned.threadID,
        nativeSessionID: assigned.nativeSessionID,
        runID: assigned.runID,
        text: assigned.text,
        async beforeModel() {
          expect(await writes.reserveModel(assigned)).toBe('allowed')
        },
        async checkpoint() {
          expect(await writes.checkpoint(assigned)).toBe(true)
        },
      })
    }
    const result = await run(lease)
    expect(result.text).toBe('First answer')
    expect(result).not.toHaveProperty('history')
    expect(await completeExecutionRun(db, lease, result)).toBe('completed')
    await acceptExecutionCommand(db, second)
    const next = await claim()
    expect(next.runID).toBe(second.runID)
    expect(next.nativeSessionID).toBe(lease.nativeSessionID)
    expect(next).not.toHaveProperty('history')
    const continued = await run(next)
    expect(continued.text).toBe('Second answer')
    expect(JSON.stringify(requests[1])).toContain('First answer')
    expect(JSON.stringify(requests[1])).toContain('Hello')
    expect(await completeExecutionRun(db, next, continued)).toBe('completed')
    const archive = await db
      .selectFrom('execution.conversations')
      .select('legacy_history')
      .where('thread_id', '=', first.threadID)
      .executeTakeFirstOrThrow()
    expect(archive.legacy_history).toEqual([])
    expect(JSON.stringify(await events(first.runID))).not.toContain('platform-input')
  } finally {
    await provider.stop(true)
    await rm(statePath, { recursive: true, force: true })
    await clearOwnedExecutionThread(db, first.threadID)
  }
}, 15000)

test('concurrent canonical acceptance has one winner and retains conflicting replay', async () => {
  const command = start()
  try {
    // Join every real admission even on failure; a rejected sibling must not
    // outlive this test and leave queued work for the next global scheduler.
    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, () => acceptExecutionCommand(db, command)),
    )
    const outcomes = settled.map((result) => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    })
    expect(outcomes.filter((outcome) => outcome === 'accepted')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === 'replay')).toHaveLength(7)
    expect(
      await acceptExecutionCommand(db, {
        ...command,
        input: { ...command.input, text: 'different' },
      }),
    ).toBe('conflict')
    expect(
      await acceptExecutionCommand(db, {
        ...command,
        commandID: crypto.randomUUID(),
      }),
    ).toBe('conflict')
    const lease = await claim()
    expect(lease).toMatchObject({
      runID: command.runID,
      text: 'Hello',
    })
    expect(await appendExecutionText(db, lease, 'Answer')).toBe(true)
    expect(
      await completeExecutionRun(db, lease, {
        text: 'Answer',
      }),
    ).toBe('completed')
    const stored = await storedAssistantID(lease.runID)
    expect(stored).toBeString()
    expect(stored).not.toBe(command.input.messageID)
    expect((await events(lease.runID)).slice(1)).toMatchObject([
      { kind: 'assistant-text', messageID: stored, delta: 'Answer' },
      { kind: 'run-completed', messageID: stored, text: 'Answer' },
    ])
    expect(await acceptExecutionCommand(db, command)).toBe('replay')
    expect((await events(command.runID)).map((event) => event.kind)).toEqual([
      'run-started',
      'assistant-text',
      'run-completed',
    ])
  } finally {
    await clearOwnedExecutionThread(db, command.threadID)
  }
})

test('concurrent claim serializes a thread and preserves native session identity for its next run', async () => {
  const first = start()
  const second = start(first.threadID)
  await acceptExecutionCommand(db, first)
  await acceptExecutionCommand(db, second)
  const claims = await Promise.all(
    Array.from({ length: 8 }, () =>
      claimExecutionRun(db, { ownerID: crypto.randomUUID(), leaseMs: 60000 }),
    ),
  )
  const winners = claims.filter((lease) => lease !== null)
  expect(winners).toHaveLength(1)
  const lease = winners[0]
  if (lease === undefined) throw new Error('Missing winner')
  expect(await appendExecutionText(db, lease, 'Answer')).toBe(true)
  expect(
    await completeExecutionRun(db, lease, {
      text: 'Answer',
    }),
  ).toBe('completed')
  expect(
    await completeExecutionRun(db, lease, {
      text: 'duplicate',
    }),
  ).toBe('lost')
  const next = await claim()
  expect(next.threadID).toBe(first.threadID)
  expect(next.fence).toBeGreaterThan(lease.fence)
  expect(next.nativeSessionID).toBe(lease.nativeSessionID)
  expect(next).not.toHaveProperty('history')
  expect(await failExecutionRun(db, next, 'execution-error')).toBe('failed')
  expect(JSON.stringify(await events(lease.runID))).not.toContain(lease.nativeSessionID)
})

test('cancel before start is retained and queued cancellation is immediately terminal', async () => {
  const command = start()
  const cancel = cancellation(command)
  expect(await acceptExecutionCommand(db, cancel)).toBe('accepted')
  expect(await acceptExecutionCommand(db, cancel)).toBe('replay')
  expect(await acceptExecutionCommand(db, command)).toBe('accepted')
  expect(await claimExecutionRun(db, { ownerID: 'worker', leaseMs: 60000 })).toBeNull()
  expect((await events(command.runID)).map((event) => event.kind)).toEqual(['run-cancelled'])
  const queued = start()
  await acceptExecutionCommand(db, queued)
  expect(await acceptExecutionCommand(db, cancellation(queued))).toBe('accepted')
  expect((await events(queued.runID)).map((event) => event.kind)).toEqual(['run-cancelled'])
})

test('locked completion chooses racing cancellation without a completed receipt', async () => {
  const command = start()
  await acceptExecutionCommand(db, command)
  const lease = await claim()
  expect(await renewExecutionLease(db, lease, 60000)).toBe('renewed')
  await acceptExecutionCommand(db, cancellation(command))
  expect(await renewExecutionLease(db, lease, 60000)).toBe('cancel')
  expect(await bindExecutionWrites(db).reserveModel(lease)).toBe('cancel')
  expect(await bindExecutionWrites(db).beginEffect(lease)).toBe('cancel')
  expect(await appendExecutionText(db, lease, 'late')).toBe(false)
  expect(
    await completeExecutionRun(db, lease, {
      text: 'late',
    }),
  ).toBe('cancelled')
  expect(await cancelExecutionRun(db, lease)).toBe('lost')
  expect(await renewExecutionLease(db, lease, 60000)).toBe('lost')
  expect((await events(command.runID)).map((event) => event.kind)).toEqual([
    'run-started',
    'run-cancelled',
  ])
})

test('expiry cannot take over a physical writer; startup recovery fences uncertain effects', async () => {
  const command = start()
  await acceptExecutionCommand(db, command)
  const lease = await claim()
  expect(await bindExecutionWrites(db).beginEffect(lease)).toBe('allowed')
  await expire(lease)
  expect(await appendExecutionText(db, lease, 'late')).toBe(false)
  expect(await completeExecutionRun(db, lease, { text: 'late' })).toBe('lost')
  expect(await failExecutionRun(db, lease, 'execution-error')).toBe('lost')
  expect(await cancelExecutionRun(db, lease)).toBe('lost')
  expect(await renewExecutionLease(db, lease, 60000)).toBe('lost')
  expect(await claimExecutionRun(db, { ownerID: 'recovery', leaseMs: 60000 })).toBeNull()
  expect((await events(command.runID)).map((event) => event.kind)).toEqual(['run-started'])
  // This fixture has no live worker/native writer; recovery models startup after its physical stop.
  await recoverNativeRequests(db)
  expect((await events(command.runID)).at(-1)).toMatchObject({
    kind: 'run-failed',
    reason: 'sandbox-recovery-required',
  })
  const queued = start(command.threadID)
  await acceptExecutionCommand(db, queued)
  expect(await claimExecutionRun(db, { ownerID: 'replacement', leaseMs: 60000 })).toBeNull()
  expect((await events(queued.runID)).at(-1)).toMatchObject({
    kind: 'run-failed',
    reason: 'sandbox-recovery-required',
  })
  const state = await db
    .selectFrom('execution.conversations')
    .select(['sandbox_recovery_required', 'workspace_reset_required'])
    .where('thread_id', '=', lease.threadID)
    .executeTakeFirstOrThrow()
  expect(state).toEqual({ sandbox_recovery_required: true, workspace_reset_required: true })
  expect(await completeExecutionRun(db, lease, { text: 'stale' })).toBe('lost')
})

test('lease expiration while waiting for authority lock cannot commit terminal events', async () => {
  const command = start()
  await acceptExecutionCommand(db, command)
  const lease = await claim()
  await db
    .updateTable('execution.conversations')
    .set({ lease_until: sql`clock_timestamp() + interval '500 milliseconds'` })
    .where('thread_id', '=', lease.threadID)
    .execute()
  const blocked = await db.transaction().execute(async (tx) => {
    await tx
      .selectFrom('execution.conversations')
      .select('thread_id')
      .where('thread_id', '=', lease.threadID)
      .forUpdate()
      .execute()
    const completion = completeExecutionRun(db, lease, {
      text: 'expired',
    })
    await sql`select pg_sleep(1)`.execute(tx)
    return { completion }
  })
  expect(await blocked.completion).toBe('lost')
  expect((await events(command.runID)).map((event) => event.kind)).toEqual(['run-started'])
  expect(await claimExecutionRun(db, { ownerID: 'recovery', leaseMs: 60000 })).toBeNull()
})

test('independent threads can claim concurrently while fabricated ownership cannot mutate a run', async () => {
  const commands = [start(), start()]
  await Promise.all(commands.map((command) => acceptExecutionCommand(db, command)))
  const settled = await Promise.allSettled([claim(), claim()])
  const leases = settled.map((result) => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
  expect(new Set(leases.map((lease) => lease.threadID)).size).toBe(2)
  for (const lease of leases) {
    for (const stale of [
      { ...lease, fence: lease.fence + 1 },
      { ...lease, ownerID: 'not-owner' },
      { ...lease, engine: lease.engine === 'pi' ? ('openai' as const) : ('pi' as const) },
      { ...lease, nativeSessionID: crypto.randomUUID() },
    ]) {
      expect(await bindExecutionWrites(db).reserveModel(stale)).toBe('lost')
      expect(await bindExecutionWrites(db).beginEffect(stale)).toBe('lost')
      expect(await bindExecutionWrites(db).checkpoint(stale)).toBe(false)
      expect(await renewExecutionLease(db, stale, 60000)).toBe('lost')
      expect(await appendExecutionText(db, stale, 'unauthorized')).toBe(false)
      expect(
        await completeExecutionRun(db, stale, {
          text: 'unauthorized',
        }),
      ).toBe('lost')
      expect(await cancelExecutionRun(db, stale)).toBe('lost')
      expect(await failExecutionRun(db, stale, 'interrupted')).toBe('lost')
    }
    expect(await failExecutionRun(db, lease, 'execution-error')).toBe('failed')
    expect((await events(lease.runID)).map((event) => event.kind)).toEqual([
      'run-started',
      'run-failed',
    ])
  }
})

test('concurrent different commands cannot reuse a run across threads and conflicts leave no inbox acceptance', async () => {
  const first = start()
  const second = { ...start(), runID: first.runID }
  const outcomes = await Promise.all([
    acceptExecutionCommand(db, first),
    acceptExecutionCommand(db, second),
  ])
  expect(outcomes.sort()).toEqual(['accepted', 'conflict'])
  // Resolve the winner from durable input, not promise completion order.
  const lease = await claim()
  const loser = lease.threadID === first.threadID ? second : first
  expect(await acceptExecutionCommand(db, loser)).toBe('conflict')
  const accepted = lease.threadID === first.threadID ? first : second
  expect(await acceptExecutionCommand(db, accepted)).toBe('replay')
  expect(
    await acceptExecutionCommand(db, {
      ...cancellation(accepted),
      threadID: loser.threadID,
    }),
  ).toBe('conflict')
  expect(await cancelExecutionRun(db, lease)).toBe('cancelled')
})

function uppercaseStart(): StartCommand {
  const threadID = crypto.randomUUID().toUpperCase()
  ownedThreads.add(threadID.toLowerCase())
  return {
    version: 1,
    kind: 'start',
    commandID: crypto.randomUUID().toUpperCase(),
    threadID,
    runID: crypto.randomUUID().toUpperCase(),
    input: {
      messageID: crypto.randomUUID().toUpperCase(),
      text: ' Hello ',
    },
  }
}

test('UUID case replays canonical and legacy commands without altering owner authority', async () => {
  const command = uppercaseStart()
  const lower: StartCommand = {
    ...command,
    commandID: command.commandID.toLowerCase(),
    threadID: command.threadID.toLowerCase(),
    runID: command.runID.toLowerCase(),
    input: {
      ...command.input,
      messageID: command.input.messageID.toLowerCase(),
    },
  }
  expect(await acceptExecutionCommand(db, command)).toBe('accepted')
  expect(await acceptExecutionCommand(db, lower)).toBe('replay')
  expect(await acceptExecutionCommand(db, command)).toBe('replay')
  const inbox = await db
    .selectFrom('execution.command_inbox')
    .select('command')
    .where('command_id', '=', command.commandID)
    .executeTakeFirstOrThrow()
  expect(startCommandSchema.parse(inbox.command)).toEqual(lower)
  // Canonical parsing also supports commands persisted before this normalization fix.
  await db
    .updateTable('execution.command_inbox')
    .set({ command: sql`${JSON.stringify(command)}::jsonb` })
    .where('command_id', '=', command.commandID)
    .execute()
  expect(await acceptExecutionCommand(db, lower)).toBe('replay')
  const lease = await claimExecutionRun(db, {
    ownerID: 'Worker-ABC',
    leaseMs: 60000,
  })
  if (lease === null) {
    throw new Error('Expected lease')
  }
  expect(lease).toMatchObject({
    runID: lower.runID,
    threadID: lower.threadID,
    ownerID: 'Worker-ABC',
  })
  expect(
    await db
      .selectFrom('execution.runs')
      .select(['command_id', 'message_id'])
      .where('run_id', '=', lease.runID)
      .executeTakeFirstOrThrow(),
  ).toEqual({
    command_id: lower.commandID,
    message_id: lower.input.messageID,
  })
  expect(await renewExecutionLease(db, { ...lease, ownerID: 'worker-abc' }, 60000)).toBe('lost')
  expect(
    await completeExecutionRun(db, lease, {
      text: 'Answer',
    }),
  ).toBe('completed')
})

test('uppercase cancellation of a queued canonical run emits canonical JSON and replays lowercase', async () => {
  const command: StartCommand = {
    ...start(),
    threadID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
  }
  ownedThreads.add(command.threadID)
  await acceptExecutionCommand(db, command)
  const cancel = {
    ...cancellation(command),
    commandID: crypto.randomUUID().toUpperCase(),
    threadID: command.threadID.toUpperCase(),
    runID: command.runID.toUpperCase(),
  }
  expect(await acceptExecutionCommand(db, cancel)).toBe('accepted')
  expect(
    await acceptExecutionCommand(db, {
      ...cancel,
      commandID: cancel.commandID.toLowerCase(),
      threadID: command.threadID,
      runID: command.runID,
    }),
  ).toBe('replay')
  expect(await acceptExecutionCommand(db, cancel)).toBe('replay')
  const row = await db
    .selectFrom('execution.event_outbox')
    .selectAll()
    .where('run_id', '=', command.runID)
    .executeTakeFirstOrThrow()
  expect(row.event).toMatchObject({
    kind: 'run-cancelled',
    threadID: command.threadID,
    runID: command.runID,
  })
})

test('uppercase leases use the locked stored assistant identity for text and completion JSON', async () => {
  const command = {
    ...start(crypto.randomUUID()),
    runID: crypto.randomUUID(),
  }
  await acceptExecutionCommand(db, command)
  const claimed = await claim()
  const assistantMessageID = crypto.randomUUID()
  await db
    .updateTable('execution.runs')
    .set({ assistant_message_id: assistantMessageID })
    .where('run_id', '=', claimed.runID)
    .execute()
  const lease = claimed
  const upperLease = {
    ...lease,
    threadID: lease.threadID.toUpperCase(),
    runID: lease.runID.toUpperCase(),
  }
  const appended = await appendExecutionText(db, upperLease, 'Answer')
  const completed = await completeExecutionRun(db, upperLease, {
    text: 'Answer',
  })
  expect(appended).toBe(true)
  expect(completed).toBe('completed')
  const rows = await db
    .selectFrom('execution.event_outbox')
    .selectAll()
    .where('run_id', '=', lease.runID)
    .orderBy('ordinal')
    .execute()
  expect(rows.map((row) => row.event)).toMatchObject([
    { kind: 'run-started', threadID: lease.threadID, runID: lease.runID },
    {
      kind: 'assistant-text',
      threadID: lease.threadID,
      runID: lease.runID,
      messageID: assistantMessageID,
      delta: 'Answer',
    },
    {
      kind: 'run-completed',
      threadID: lease.threadID,
      runID: lease.runID,
      messageID: assistantMessageID,
      text: 'Answer',
    },
  ])
})

test('uppercase lease cancellation persists canonical event identities', async () => {
  const command = {
    ...start(crypto.randomUUID()),
    runID: crypto.randomUUID(),
  }
  await acceptExecutionCommand(db, command)
  const lease = await claim()
  expect(
    await cancelExecutionRun(db, {
      ...lease,
      threadID: lease.threadID.toUpperCase(),
      runID: lease.runID.toUpperCase(),
    }),
  ).toBe('cancelled')
  const rows = await db
    .selectFrom('execution.event_outbox')
    .select('event')
    .where('run_id', '=', lease.runID)
    .orderBy('ordinal')
    .execute()
  expect(rows[1]?.event).toMatchObject({
    kind: 'run-cancelled',
    threadID: lease.threadID,
    runID: lease.runID,
  })
})

test('native identity is durable before completion and stale fences cannot replace it', async () => {
  const first = start()
  await acceptExecutionCommand(db, first)
  const lease = await claim()
  const nativeRef = { provider: 'e2b', id: 'opaque-native-id' }
  expect(await saveNativeSandbox(db, lease, nativeRef)).toBe(true)
  const row = await db
    .selectFrom('execution.conversations')
    .select('native_sandbox')
    .where('thread_id', '=', lease.threadID)
    .executeTakeFirstOrThrow()
  expect(row.native_sandbox).toEqual(nativeRef)
  expect(await completeExecutionRun(db, lease, { text: 'done' })).toBe('completed')
  await acceptExecutionCommand(db, start(first.threadID))
  const next = await claim()
  expect(next.nativeRef).toEqual(nativeRef)
  expect(await saveNativeSandbox(db, lease, { provider: 'e2b', id: 'stale' })).toBe(false)
  expect(await cancelExecutionRun(db, next)).toBe('cancelled')
})

test('accepted asset-only commands replay allocations and issue them only on their lease', async () => {
  const base = start()
  const material = {
    assetID: crypto.randomUUID().toUpperCase(),
    objectKey: 'assets/project/allocated',
    name: 'image.png',
    mimeType: 'image/png',
    byteLength: 3,
    sha256: 'a'.repeat(64),
  }
  const command = {
    ...base,
    input: { ...base.input, text: '', assets: [material] },
  }
  expect(await acceptExecutionCommand(db, command)).toBe('accepted')
  expect(await acceptExecutionCommand(db, command)).toBe('replay')
  expect(
    await acceptExecutionCommand(db, {
      ...command,
      input: {
        ...command.input,
        assets: [{ ...material, objectKey: 'other' }],
      },
    }),
  ).toBe('conflict')
  const lease = await claim()
  expect(lease.assets).toEqual([{ ...material, assetID: material.assetID.toLowerCase() }])
  expect(await cancelExecutionRun(db, lease)).toBe('cancelled')
})

test('late quarantine from a committed old fence blocks active spending but retains cleanup authority', async () => {
  const first = start()
  await acceptExecutionCommand(db, first)
  const old = await claim()
  const nativeRef = { provider: 'e2b', id: 'shared-native' }
  expect(await saveNativeSandbox(db, old, nativeRef)).toBe(true)
  expect(
    await completeExecutionRun(db, old, {
      text: 'committed',
    }),
  ).toBe('completed')
  await acceptExecutionCommand(db, start(first.threadID))
  const active = await claim()
  expect(active.nativeRef).toEqual(nativeRef)
  expect(active.fence).toBeGreaterThan(old.fence)
  await quarantineSandbox(db, old)
  expect(await renewExecutionLease(db, active, 60000)).toBe('recovery-required')
  expect(await saveNativeSandbox(db, active, { provider: 'e2b', id: 'replacement' })).toBe(false)
  expect(await appendExecutionText(db, active, 'unsafe')).toBe(false)
  const held = await db
    .selectFrom('execution.conversations')
    .selectAll()
    .where('thread_id', '=', first.threadID)
    .executeTakeFirstOrThrow()
  expect(held.active_run_id).toBe(active.runID)
  expect(held.sandbox_recovery_required).toBe(true)
  expect(held.legacy_history).toEqual([])
  expect(held.native_sandbox).toEqual(nativeRef)
  expect(await completeExecutionRun(db, active, { text: 'unsafe' })).toBe('failed')
  expect(await cancelExecutionRun(db, active)).toBe('lost')
  expect(await failExecutionRun(db, active, 'execution-error')).toBe('lost')
  expect(await events(old.runID)).toMatchObject([
    { kind: 'run-started' },
    { kind: 'run-completed' },
  ])
  expect(await events(active.runID)).toMatchObject([
    { kind: 'run-started' },
    { kind: 'run-failed', reason: 'sandbox-recovery-required' },
  ])
})

test('typed asset replay normalizes property order and UUID case but preserves exact facts', async () => {
  const base = start()
  const first = {
    sha256: 'a'.repeat(64),
    byteLength: 3,
    mimeType: 'image/png',
    name: 'first.png',
    objectKey: 'allocated/first',
    assetID: crypto.randomUUID().toUpperCase(),
  }
  const second = {
    ...first,
    assetID: crypto.randomUUID(),
    objectKey: 'allocated/second',
  }
  const command: StartCommand = {
    ...base,
    commandID: base.commandID.toUpperCase(),
    threadID: base.threadID.toUpperCase(),
    runID: base.runID.toUpperCase(),
    input: {
      messageID: base.input.messageID.toUpperCase(),
      text: ' exact text ',
      assets: [first, second],
    },
  }
  try {
    expect(await acceptExecutionCommand(db, command)).toBe('accepted')
    const parsed = startCommandSchema.parse(command)
    expect(await acceptExecutionCommand(db, parsed)).toBe('replay')
    expect(await acceptExecutionCommand(db, command)).toBe('replay')
    for (const input of [
      { ...parsed.input, text: 'exact text' },
      { ...parsed.input, assets: [second, first] },
      {
        ...parsed.input,
        assets: [{ ...first, objectKey: 'different' }, second],
      },
    ]) {
      expect(await acceptExecutionCommand(db, { ...parsed, input })).toBe('conflict')
    }
    const conflictingID = crypto.randomUUID()
    expect(await acceptExecutionCommand(db, { ...parsed, commandID: conflictingID })).toBe(
      'conflict',
    )
    expect(
      await db
        .selectFrom('execution.command_inbox')
        .select('command_id')
        .where('command_id', '=', conflictingID)
        .execute(),
    ).toEqual([])
    const row = await db
      .selectFrom('execution.command_inbox')
      .select('command')
      .where('command_id', '=', base.commandID)
      .executeTakeFirstOrThrow()
    const expected = {
      version: 1,
      kind: 'start',
      commandID: base.commandID,
      threadID: base.threadID,
      runID: base.runID,
      input: {
        messageID: base.input.messageID,
        text: ' exact text ',
        assets: [{ ...first, assetID: first.assetID.toLowerCase() }, second],
      },
    } satisfies StartCommand
    expect(row.command).toEqual(expected)
    expect(startCommandSchema.parse(row.command)).toEqual(expected)
  } finally {
    await clearOwnedExecutionThread(db, base.threadID)
  }
})

for (const field of ['commandID', 'text'] as const) {
  test(`admission rejects retained start command ${field} conflict before binding or spending`, async () => {
    const command = start()
    await acceptExecutionCommand(db, command)
    const conflicting =
      field === 'text'
        ? { ...command, input: { ...command.input, text: 'Altered canonical input' } }
        : { ...command, commandID: crypto.randomUUID() }
    await db
      .updateTable('execution.command_inbox')
      .set({ command: sql`${JSON.stringify(conflicting)}::jsonb` })
      .where('command_id', '=', command.commandID)
      .execute()
    await Promise.resolve(
      expect(
        claimExecutionRun(db, { ownerID: 'integrity-worker', leaseMs: 60000 }),
      ).rejects.toThrow('Accepted input does not match assigned request'),
    )
    const run = await db
      .selectFrom('execution.runs')
      .select(['status', 'native_session_id', 'model_call_count'])
      .where('run_id', '=', command.runID)
      .executeTakeFirstOrThrow()
    expect(run).toEqual({ status: 'queued', native_session_id: null, model_call_count: 0 })
    expect(await events(command.runID)).toEqual([])
  })
}
