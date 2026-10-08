import { afterAll, afterEach, expect, test } from 'bun:test'
import { sql } from 'kysely'
import type { StartCommand } from '@vid/contract/execution'
import { acceptExecutionCommand } from '../../apps/agent/src/execution/db/command-acceptance'
import { recordTerminal } from '../../apps/agent/src/execution/db/terminal-writes'
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
    input: { messageID: crypto.randomUUID(), text: 'Original question\nwith whitespace  ' },
  }
  expect(await acceptExecutionCommand(db, command)).toBe('accepted')
  return command
}

async function completed(command: StartCommand, text = 'Actual final answer') {
  const messageID = crypto.randomUUID()
  await db.transaction().execute(async (tx) => {
    await tx
      .selectFrom('execution.conversations')
      .select('thread_id')
      .where('thread_id', '=', command.threadID)
      .forUpdate()
      .executeTakeFirstOrThrow()
    await tx
      .updateTable('execution.runs')
      .set({ assistant_message_id: messageID })
      .where('run_id', '=', command.runID)
      .execute()
    await recordTerminal(tx, {
      version: 1,
      kind: 'run-completed',
      eventID: crypto.randomUUID(),
      threadID: command.threadID,
      runID: command.runID,
      messageID,
      text,
    })
  })
  return messageID
}

async function context(threadID: string) {
  const { buildConversationContext } =
    await import('../../apps/agent/src/execution/db/conversation-context')
  return await db.transaction().execute(async (tx) => {
    await tx
      .selectFrom('execution.conversations')
      .select('thread_id')
      .where('thread_id', '=', threadID)
      .forUpdate()
      .executeTakeFirstOrThrow()
    return await buildConversationContext(tx, threadID)
  })
}

test('oversized history is rejected before private message bodies reach the worker', async () => {
  const command = await accepted()
  await completed(command, 'x'.repeat(4 * 1024 * 1024))
  const { buildConversationContext } =
    await import('../../apps/agent/src/execution/db/conversation-context')
  let largestResponse = 0
  const observed = db.withPlugin({
    transformQuery: ({ node }) => node,
    async transformResult({ result }) {
      largestResponse = Math.max(
        largestResponse,
        new TextEncoder().encode(JSON.stringify(result.rows)).byteLength,
      )
      return result
    },
  })
  expect(
    await observed
      .transaction()
      .execute((tx) => buildConversationContext(tx, command.threadID))
      .catch((cause: unknown) => cause),
  ).toBeInstanceOf(Error)
  expect(largestResponse).toBeLessThan(4096)
})

test('terminal completion persists business result independently of outbox retention', async () => {
  const command = await accepted()
  await completed(command)
  await db.deleteFrom('execution.event_outbox').where('run_id', '=', command.runID).execute()
  const row = await db
    .selectFrom('execution.runs')
    .select('completion')
    .where('run_id', '=', command.runID)
    .executeTakeFirstOrThrow()
  expect(row.completion).toEqual({ text: 'Actual final answer' })
})

test('context rereads original completed text and identities after outbox deletion', async () => {
  const first = await accepted()
  const firstMessageID = await completed(first)
  const second = await accepted(first.threadID)
  const secondMessageID = await completed(second, 'Second final answer')
  await db.deleteFrom('execution.event_outbox').where('thread_id', '=', first.threadID).execute()
  const expected = {
    version: 1 as const,
    throughRunID: second.runID,
    turns: [
      {
        runID: first.runID,
        input: first.input,
        output: { messageID: firstMessageID, text: 'Actual final answer' },
      },
      {
        runID: second.runID,
        input: second.input,
        output: { messageID: secondMessageID, text: 'Second final answer' },
      },
    ],
  }
  expect(await context(first.threadID)).toEqual(expected)
  expect(await context(first.threadID)).toEqual(expected)
})

test('context excludes queued running failed and cancelled runs', async () => {
  const command = await accepted()
  for (const status of ['running', 'failed', 'cancelled'] as const) {
    const other = await accepted(command.threadID)
    await db
      .updateTable('execution.runs')
      .set({ status })
      .where('run_id', '=', other.runID)
      .execute()
  }
  expect(await context(command.threadID)).toEqual({ version: 1, throughRunID: null, turns: [] })
})

test('completed run without a final business result fails closed', async () => {
  const command = await accepted()
  await db
    .updateTable('execution.runs')
    .set({ status: 'completed', assistant_message_id: crypto.randomUUID() })
    .where('run_id', '=', command.runID)
    .execute()
  expect(await context(command.threadID).catch((error: unknown) => error)).toBeInstanceOf(Error)
})

for (const field of ['commandID', 'threadID', 'runID', 'messageID', 'text'] as const) {
  test(`context rejects retained start command ${field} conflict`, async () => {
    const command = await accepted()
    await completed(command)
    const conflicting =
      field === 'messageID' || field === 'text'
        ? {
            ...command,
            input: {
              ...command.input,
              [field]: field === 'text' ? 'Altered text' : crypto.randomUUID(),
            },
          }
        : { ...command, [field]: crypto.randomUUID() }
    await db
      .updateTable('execution.command_inbox')
      .set({ command: sql`${JSON.stringify(conflicting)}::jsonb` })
      .where('command_id', '=', command.commandID)
      .execute()
    expect(await context(command.threadID).catch((error: unknown) => error)).toMatchObject({
      message: 'Completed run input conflicts with accepted identity',
    })
  })
}

for (const completion of [
  null,
  { text: 42 },
  { text: 'answer', providerCheckpoint: {} },
  { text: 'answer', sources: [{ url: 'invalid' }] },
  { text: 'answer', assets: [{}] },
]) {
  test(`context rejects invalid durable completion ${JSON.stringify(completion)}`, async () => {
    const command = await accepted()
    await completed(command)
    await db
      .updateTable('execution.runs')
      .set({ completion: sql`${JSON.stringify(completion)}::jsonb` })
      .where('run_id', '=', command.runID)
      .execute()
    expect(await context(command.threadID).catch((error: unknown) => error)).toBeInstanceOf(Error)
  })
}

for (const kind of ['run-failed', 'run-cancelled'] as const) {
  test(`${kind} does not persist a successful business completion`, async () => {
    const command = await accepted()
    await db.transaction().execute(async (tx) => {
      await tx
        .selectFrom('execution.conversations')
        .select('thread_id')
        .where('thread_id', '=', command.threadID)
        .forUpdate()
        .executeTakeFirstOrThrow()
      await recordTerminal(tx, {
        version: 1,
        eventID: crypto.randomUUID(),
        threadID: command.threadID,
        runID: command.runID,
        ...(kind === 'run-failed' ? { kind, reason: 'execution-error' as const } : { kind }),
      })
    })
    const row = await db
      .selectFrom('execution.runs')
      .select('completion')
      .where('run_id', '=', command.runID)
      .executeTakeFirstOrThrow()
    expect(row.completion).toBeNull()
  })
}
