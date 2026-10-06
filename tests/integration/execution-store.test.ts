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
  saveNativeSandbox,
  quarantineSandbox,
} from '../../apps/agent/src/db/run-writes'
import { afterAll, expect, test } from 'bun:test'
import {
  executionEventSchema,
  startCommandSchema,
  type StartCommand,
} from '@vid/contract/execution'
import { sql } from 'kysely'
import type { ExecutionLease } from '../../apps/agent/src/execute-run'
import { createPiHarness } from '../../apps/agent/src/harness/pi'
import { openTestDatabase } from './database-fixture'

const { db, close } = openTestDatabase()
const ownedThreads = new Set<string>()
afterAll(async () => {
  try {
    for (const threadID of ownedThreads)
      await removeExecutionConversation(threadID)
  } finally {
    await close()
  }
})

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
      if (text === undefined)
        return new Response('Unexpected request', { status: 500 })
      return new Response(
        [
          { delta: { role: 'assistant', content: text }, finish_reason: null },
          { delta: {}, finish_reason: 'stop' },
        ]
          .map(
            (chunk) =>
              `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, ...chunk }] })}\n\n`,
          )
          .join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
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

async function removeExecutionConversation(threadID: string) {
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

test('fresh SQL history starts a Pi turn and persists canonical history for the next lease', async () => {
  const first = start()
  const second = start(first.threadID)
  const { provider, requests, options, input } = piProviderFixture()
  try {
    expect(await acceptExecutionCommand(db, first)).toBe('accepted')
    const lease = await claim()
    expect(lease.runID).toBe(first.runID)
    expect(lease.history).toEqual([])
    expect(lease).not.toHaveProperty('commandID')
    expect(lease).not.toHaveProperty('messageID')
    const retained = await db
      .selectFrom('execution.runs')
      .select(['command_id', 'message_id'])
      .where('run_id', '=', first.runID)
      .executeTakeFirstOrThrow()
    expect(retained).toEqual({
      command_id: first.commandID,
      message_id: first.input.messageID,
    })
    const result = await createPiHarness(options).turn({
      ...input,
      text: lease.text,
      history: lease.history,
    })
    expect(result.text).toBe('First answer')
    expect(
      await completeExecutionRun(db, lease, {
        text: result.text,
        history: result.history,
      }),
    ).toBe(true)
    expect(await acceptExecutionCommand(db, second)).toBe('accepted')
    const next = await claim()
    expect(next.runID).toBe(second.runID)
    expect(next.history).toEqual(JSON.parse(JSON.stringify(result.history)))
    const continued = await createPiHarness(options).turn({
      ...input,
      text: 'Continue',
      history: next.history,
    })
    expect(continued.text).toBe('Second answer')
    expect(JSON.stringify(requests[1])).toContain('First answer')
    expect(JSON.stringify(requests[1])).toContain('Hello')
    expect(
      await completeExecutionRun(db, next, {
        text: continued.text,
        history: continued.history,
      }),
    ).toBe(true)
  } finally {
    try {
      await removeExecutionConversation(first.threadID)
    } finally {
      await provider.stop(true)
    }
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
      history: [],
    })
    expect(await appendExecutionText(db, lease, 'Answer')).toBe(true)
    expect(
      await completeExecutionRun(db, lease, {
        text: 'Answer',
        history: { private: ['tool-secret'] },
      }),
    ).toBe(true)
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
    await removeExecutionConversation(command.threadID)
  }
})

test('concurrent claim serializes a thread and passes only committed private history to its next run', async () => {
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
      history: { opaque: 'private tool state' },
    }),
  ).toBe(true)
  expect(
    await completeExecutionRun(db, lease, {
      text: 'duplicate',
      history: [],
    }),
  ).toBe(false)
  const next = await claim()
  expect(next.threadID).toBe(first.threadID)
  expect(next.fence).toBeGreaterThan(lease.fence)
  expect(next.history).toEqual({ opaque: 'private tool state' })
  expect(await failExecutionRun(db, next, 'execution-error')).toBe(true)
  expect(JSON.stringify(await events(lease.runID))).not.toContain(
    'private tool state',
  )
})

test('cancel before start is retained and queued cancellation is immediately terminal', async () => {
  const command = start()
  const cancel = cancellation(command)
  expect(await acceptExecutionCommand(db, cancel)).toBe('accepted')
  expect(await acceptExecutionCommand(db, cancel)).toBe('replay')
  expect(await acceptExecutionCommand(db, command)).toBe('accepted')
  expect(
    await claimExecutionRun(db, { ownerID: 'worker', leaseMs: 60000 }),
  ).toBeNull()
  expect((await events(command.runID)).map((event) => event.kind)).toEqual([
    'run-cancelled',
  ])
  const queued = start()
  await acceptExecutionCommand(db, queued)
  expect(await acceptExecutionCommand(db, cancellation(queued))).toBe(
    'accepted',
  )
  expect((await events(queued.runID)).map((event) => event.kind)).toEqual([
    'run-cancelled',
  ])
})

test('locked completion chooses racing cancellation without committing history', async () => {
  const command = start()
  await acceptExecutionCommand(db, command)
  const lease = await claim()
  expect(await renewExecutionLease(db, lease, 60000)).toBe('renewed')
  await acceptExecutionCommand(db, cancellation(command))
  expect(await renewExecutionLease(db, lease, 60000)).toBe('cancel')
  expect(await appendExecutionText(db, lease, 'late')).toBe(false)
  expect(
    await completeExecutionRun(db, lease, {
      text: 'late',
      history: ['late secret'],
    }),
  ).toBe('cancelled')
  expect(await cancelExecutionRun(db, lease)).toBe(false)
  expect(await renewExecutionLease(db, lease, 60000)).toBe('lost')
  expect((await events(command.runID)).map((event) => event.kind)).toEqual([
    'run-started',
    'run-cancelled',
  ])
})

test('expired external operation is interrupted rather than automatically executed again', async () => {
  const command = start()
  await acceptExecutionCommand(db, command)
  const lease = await claim()
  await expire(lease)
  expect(await appendExecutionText(db, lease, 'late')).toBe(false)
  expect(
    await completeExecutionRun(db, lease, {
      text: 'late',
      history: ['secret'],
    }),
  ).toBe(false)
  expect(await failExecutionRun(db, lease, 'execution-error')).toBe(false)
  expect(await cancelExecutionRun(db, lease)).toBe(false)
  expect(await renewExecutionLease(db, lease, 60000)).toBe('lost')
  expect(
    await claimExecutionRun(db, { ownerID: 'recovery', leaseMs: 60000 }),
  ).toBeNull()
  expect(
    await claimExecutionRun(db, { ownerID: 'recovery', leaseMs: 60000 }),
  ).toBeNull()
  expect(await events(command.runID)).toMatchObject([
    { kind: 'run-started' },
    { kind: 'run-failed', reason: 'interrupted' },
  ])
  const queued = start(command.threadID)
  await acceptExecutionCommand(db, queued)
  expect(
    await claimExecutionRun(db, { ownerID: 'replacement', leaseMs: 60000 }),
  ).toBeNull()
  expect((await events(queued.runID)).at(-1)).toMatchObject({
    kind: 'run-failed',
    reason: 'sandbox-recovery-required',
  })
  const state = await db
    .selectFrom('execution.conversations')
    .select('sandbox_recovery_required')
    .where('thread_id', '=', lease.threadID)
    .executeTakeFirstOrThrow()
  expect(state.sandbox_recovery_required).toBe(true)
  expect(
    await completeExecutionRun(db, lease, { text: 'stale', history: [] }),
  ).toBe(false)
})

test('lease expiration while waiting for authority lock cannot commit history or events', async () => {
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
      history: ['expired secret'],
    })
    await sql`select pg_sleep(1)`.execute(tx)
    return { completion }
  })
  expect(await blocked.completion).toBe(false)
  expect((await events(command.runID)).map((event) => event.kind)).toEqual([
    'run-started',
  ])
  expect(
    await claimExecutionRun(db, { ownerID: 'recovery', leaseMs: 60000 }),
  ).toBeNull()
})

test('independent threads can claim concurrently while fabricated ownership cannot mutate a run', async () => {
  const commands = [start(), start()]
  await Promise.all(
    commands.map((command) => acceptExecutionCommand(db, command)),
  )
  const leases = await Promise.all([claim(), claim()])
  expect(new Set(leases.map((lease) => lease.threadID)).size).toBe(2)
  for (const lease of leases) {
    for (const stale of [
      { ...lease, fence: lease.fence + 1 },
      { ...lease, ownerID: 'not-owner' },
    ]) {
      expect(await renewExecutionLease(db, stale, 60000)).toBe('lost')
      expect(await appendExecutionText(db, stale, 'unauthorized')).toBe(false)
      expect(
        await completeExecutionRun(db, stale, {
          text: 'unauthorized',
          history: ['secret'],
        }),
      ).toBe(false)
      expect(await cancelExecutionRun(db, stale)).toBe(false)
      expect(await failExecutionRun(db, stale, 'interrupted')).toBe(false)
    }
    expect(await failExecutionRun(db, lease, 'execution-error')).toBe(true)
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
  expect(await cancelExecutionRun(db, lease)).toBe(true)
})

function uppercaseStart(): StartCommand {
  const threadID = 'BCDEFABC-DEFA-4BCD-8EFA-BCDEFABCDEFA'
  ownedThreads.add(threadID.toLowerCase())
  return {
    version: 1,
    kind: 'start',
    commandID: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF',
    threadID,
    runID: 'CDEFABCD-EFAB-4CDE-8FAB-CDEFABCDEFAB',
    input: {
      messageID: 'DEFABCDE-FABC-4DEF-8ABC-DEFABCDEFABC',
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
  expect(
    await renewExecutionLease(db, { ...lease, ownerID: 'worker-abc' }, 60000),
  ).toBe('lost')
  expect(
    await completeExecutionRun(db, lease, {
      text: 'Answer',
      history: [],
    }),
  ).toBe(true)
})

test('uppercase cancellation of a queued canonical run emits canonical JSON and replays lowercase', async () => {
  const command: StartCommand = {
    ...start(),
    threadID: 'abcdefab-cdef-4abc-8def-abcdefabcdea',
    runID: 'bcdefabc-defa-4bcd-8efa-bcdefabcdeff',
  }
  ownedThreads.add(command.threadID)
  await acceptExecutionCommand(db, command)
  const cancel = {
    ...cancellation(command),
    commandID: 'CDEFABCD-EFAB-4CDE-8FAB-CDEFABCDEFAA',
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
    ...start('abcdefab-cdef-4abc-8def-abcdefabcdeb'),
    runID: 'bcdefabc-defa-4bcd-8efa-bcdefabcdeea',
  }
  await acceptExecutionCommand(db, command)
  const claimed = await claim()
  const assistantMessageID = 'defabcde-fabc-4def-8abc-defabcdefaaa'
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
    history: [],
  })
  expect(appended).toBe(true)
  expect(completed).toBe(true)
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
    ...start('abcdefab-cdef-4abc-8def-abcdefabcdec'),
    runID: 'bcdefabc-defa-4bcd-8efa-bcdefabcdeeb',
  }
  await acceptExecutionCommand(db, command)
  const lease = await claim()
  expect(
    await cancelExecutionRun(db, {
      ...lease,
      threadID: lease.threadID.toUpperCase(),
      runID: lease.runID.toUpperCase(),
    }),
  ).toBe(true)
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
  expect(
    await completeExecutionRun(db, lease, { text: 'done', history: [] }),
  ).toBe(true)
  await acceptExecutionCommand(db, start(first.threadID))
  const next = await claim()
  expect(next.nativeRef).toEqual(nativeRef)
  expect(
    await saveNativeSandbox(db, lease, { provider: 'e2b', id: 'stale' }),
  ).toBe(false)
  expect(await cancelExecutionRun(db, next)).toBe(true)
})

test('accepted asset-only commands replay allocations and issue them only on their lease', async () => {
  const base = start()
  const material = {
    assetID: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF',
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
  expect(lease.assets).toEqual([
    { ...material, assetID: material.assetID.toLowerCase() },
  ])
  expect(await cancelExecutionRun(db, lease)).toBe(true)
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
      history: ['committed'],
    }),
  ).toBe(true)
  await acceptExecutionCommand(db, start(first.threadID))
  const active = await claim()
  expect(active.nativeRef).toEqual(nativeRef)
  expect(active.fence).toBeGreaterThan(old.fence)
  await quarantineSandbox(db, old)
  expect(await renewExecutionLease(db, active, 60000)).toBe('recovery-required')
  expect(
    await saveNativeSandbox(db, active, { provider: 'e2b', id: 'replacement' }),
  ).toBe(false)
  expect(await appendExecutionText(db, active, 'unsafe')).toBe(false)
  expect(
    await completeExecutionRun(db, active, {
      text: 'unsafe',
      history: ['unsafe'],
    }),
  ).toBe(false)
  expect(await cancelExecutionRun(db, active)).toBe(false)
  expect(await failExecutionRun(db, active, 'interrupted')).toBe(false)
  const held = await db
    .selectFrom('execution.conversations')
    .selectAll()
    .where('thread_id', '=', first.threadID)
    .executeTakeFirstOrThrow()
  expect(held.active_run_id).toBe(active.runID)
  expect(held.sandbox_recovery_required).toBe(true)
  expect(held.history).toEqual(['committed'])
  expect(held.native_sandbox).toEqual(nativeRef)
  expect(await failExecutionRun(db, active, 'execution-error')).toBe(true)
  expect(await events(old.runID)).toMatchObject([
    { kind: 'run-started' },
    { kind: 'run-completed' },
  ])
  expect(await events(active.runID)).toMatchObject([
    { kind: 'run-started' },
    { kind: 'run-failed', reason: 'execution-error' },
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
      expect(await acceptExecutionCommand(db, { ...parsed, input })).toBe(
        'conflict',
      )
    }
    const conflictingID = crypto.randomUUID()
    expect(
      await acceptExecutionCommand(db, { ...parsed, commandID: conflictingID }),
    ).toBe('conflict')
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
    expect(startCommandSchema.parse(row.command)).toEqual(parsed)
  } finally {
    await removeExecutionConversation(base.threadID)
  }
})
