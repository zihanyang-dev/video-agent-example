import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import {
  executionStreams,
  type ExecutionDelivery,
  type StartCommand,
} from '@vid/contract/execution'
import { createClient, type RedisClientType } from 'redis'
import { sql } from 'kysely'
import { acceptExecutionCommand } from '../../apps/agent/src/db/command-acceptance'
import { publishEvent } from '../../apps/agent/src/db/event-publication'
import {
  acceptCommandMessages,
  acceptCommands,
  initializeCommands,
} from '../../apps/agent/src/commands'
import { consumeEventBatch } from '../../apps/server/src/conversation/execution-events'
import {
  acceptExecutionEvent,
  readPublicEvents,
} from '../../apps/server/src/db/execution-events'
import { acceptMessageIntent } from '../../apps/server/src/db/submissions'
import { seedTestUser, openTestDatabase } from './database-fixture'

const { db, close } = openTestDatabase()
const threads: string[] = []
const redisURL = process.env.REDIS_URL
if (!redisURL) throw new Error('Dedicated REDIS_URL required')
let commands: RedisClientType
let reader: RedisClientType
let stream: string
let group: string
let consumerID: string
let entries: string[]

beforeEach(async () => {
  stream = executionStreams.commands
  group = executionStreams.commandGroup
  consumerID = crypto.randomUUID()
  entries = []
  commands = createClient({
    url: redisURL,
    socket: { reconnectStrategy: false },
  })
  reader = createClient({ url: redisURL, socket: { reconnectStrategy: false } })
  await Promise.all([commands.connect(), reader.connect()])
  await initializeCommands(commands)
})

afterEach(async () => {
  if (reader.isOpen) reader.destroy()
  try {
    // Only IDs published by this test are touched. Other consumers own their PEL.
    if (entries.length) {
      await commands.xAck(stream, group, entries)
      await commands.xDel(stream, entries)
    }
  } finally {
    if (commands.isOpen) commands.destroy()
  }
})

afterAll(async () => {
  try {
    if (!threads.length) return
    await db
      .deleteFrom('execution.event_outbox')
      .where('thread_id', 'in', threads)
      .execute()
    await db
      .deleteFrom('execution.runs')
      .where('thread_id', 'in', threads)
      .execute()
    await db
      .deleteFrom('execution.command_inbox')
      .where('thread_id', 'in', threads)
      .execute()
    await db
      .deleteFrom('execution.conversations')
      .where('thread_id', 'in', threads)
      .execute()
    await db
      .deleteFrom('product.execution_events')
      .where('thread_id', 'in', threads)
      .execute()
    await db
      .deleteFrom('product.command_outbox')
      .where('thread_id', 'in', threads)
      .execute()
    await db
      .deleteFrom('product.messages')
      .where('thread_id', 'in', threads)
      .execute()
    await db
      .deleteFrom('product.threads')
      .where('thread_id', 'in', threads)
      .execute()
  } finally {
    await close()
  }
})

async function useEvents() {
  stream = executionStreams.events
  group = executionStreams.eventGroup
  try {
    await commands.xGroupCreate(stream, group, '0-0', { MKSTREAM: true })
  } catch (cause) {
    if (!(cause instanceof Error) || !cause.message.startsWith('BUSYGROUP '))
      throw cause
  }
}

async function publish(fields: Record<string, string>) {
  const id = await commands.xAdd(stream, '*', fields)
  entries.push(id)
  return id
}

async function read() {
  const streams = await reader.xReadGroup(
    group,
    consumerID,
    { key: stream, id: '>' },
    { COUNT: 10, BLOCK: 10 },
  )
  return streams?.flatMap((page) => page.messages) ?? []
}

async function reclaim() {
  return await commands.xAutoClaim(
    stream,
    group,
    crypto.randomUUID(),
    0,
    '0-0',
    { COUNT: 10 },
  )
}

async function rejected(promise: Promise<unknown>) {
  const failure = await promise.catch((cause: unknown) => cause)
  if (!(failure instanceof Error))
    throw new Error('Expected an operation failure')
  return failure
}

async function fixture(): Promise<StartCommand> {
  const command: StartCommand = {
    version: 1,
    kind: 'start',
    commandID: crypto.randomUUID(),
    threadID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    input: { messageID: crypto.randomUUID(), text: 'hello' },
  }
  threads.push(command.threadID)
  await seedTestUser(db, 'transport-owner')
  await db
    .insertInto('product.threads')
    .values({ thread_id: command.threadID, owner_id: 'transport-owner' })
    .execute()
  await acceptMessageIntent(db, {
    ownerID: 'transport-owner',
    threadID: command.threadID,
    runID: command.runID,
    commandID: command.commandID,
    messageID: command.input.messageID,
    text: command.input.text,
  })
  return command
}

function startedDelivery(command: StartCommand): ExecutionDelivery {
  return {
    ordinal: 1,
    event: {
      version: 1,
      kind: 'run-started',
      eventID: crypto.randomUUID(),
      threadID: command.threadID,
      runID: command.runID,
    },
  }
}

test('command acceptance committed before a lost ACK is replayed after restart', async () => {
  const command = await fixture()
  await publish({ command: JSON.stringify(command) })
  const messages = await read()
  expect(
    (await rejected(acceptCommandMessages(db, createClient(), messages)))
      .message,
  ).toContain('closed')
  expect(await acceptExecutionCommand(db, command)).toBe('replay')
  expect((await commands.xPending(stream, group)).pending).toBe(1)

  const recovered = await reclaim()
  expect(await acceptCommandMessages(db, commands, recovered.messages)).toBe(1)
  expect((await commands.xPending(stream, group)).pending).toBe(0)
  expect(await acceptExecutionCommand(db, command)).toBe('replay')
  expect(messages).toHaveLength(1)
})

test('invalid and conflicting commands remain pending; intake fails on deleted bodies', async () => {
  const command = await fixture()
  await acceptExecutionCommand(db, command)
  for (const body of [
    'not json',
    JSON.stringify({
      ...command,
      input: { ...command.input, text: 'changed' },
    }),
  ]) {
    const id = await publish({ command: body })
    await rejected(acceptCommandMessages(db, commands, await read()))
    expect((await commands.xPending(stream, group)).pending).toBeGreaterThan(0)
    await commands.xClaim(stream, group, consumerID, 0, [id], { IDLE: 2000 })
    await commands.xDel(stream, id)
  }

  const failure = await rejected(
    acceptCommands(
      db,
      { commands, blockingReader: reader, consumerID },
      AbortSignal.timeout(2000),
    ),
  )
  expect(failure.message).toContain('Deleted pending command')
})

test('intake advances an empty reclaim page to reach older pending commands', async () => {
  const command = await fixture()
  for (let index = 0; index < 340; index++)
    await publish({ command: 'Too young to reclaim' })
  const older = await publish({ command: JSON.stringify(command) })
  const claimed = await reader.xReadGroup(
    group,
    'previous-reader',
    { key: stream, id: '>' },
    { COUNT: 512 },
  )
  expect(claimed?.[0]?.messages).toHaveLength(341)
  await commands.xClaim(stream, group, 'previous-reader', 0, [older], {
    IDLE: 2000,
  })

  const empty = await commands.xAutoClaim(stream, group, 'probe', 1000, '0-0', {
    COUNT: 32,
  })
  expect(empty.messages).toEqual([])
  expect(empty.nextId).not.toBe('0-0')
  const stop = new AbortController()
  const intake = acceptCommands(
    db,
    { commands, blockingReader: reader, consumerID },
    stop.signal,
  )
  let accepted = false
  try {
    const deadline = performance.now() + 700
    while (!accepted && performance.now() < deadline) {
      const row = await db
        .selectFrom('execution.command_inbox')
        .select('command_id')
        .where('command_id', '=', command.commandID)
        .executeTakeFirst()
      accepted = row !== undefined
      await Bun.sleep(accepted ? 0 : 10)
    }
  } finally {
    stop.abort()
    await intake
  }
  expect(accepted).toBeTrue()
  expect((await commands.xPending(stream, group)).pending).toBe(340)
})

test('lost XADD acknowledgement republishes the same event identity and ordinal', async () => {
  await useEvents()
  const command = await fixture()
  await acceptExecutionCommand(db, command)
  await acceptExecutionCommand(db, {
    version: 1,
    kind: 'cancel',
    commandID: crypto.randomUUID(),
    threadID: command.threadID,
    runID: command.runID,
  })
  const row = await db
    .selectFrom('execution.event_outbox')
    .selectAll()
    .where('run_id', '=', command.runID)
    .executeTakeFirstOrThrow()
  const send = async (delivery: ExecutionDelivery) => {
    await publish({ delivery: JSON.stringify(delivery) })
  }
  expect(
    (
      await rejected(
        publishEvent(db, {
          eventID: row.event_id,
          publish: async (delivery) => {
            await send(delivery)
            throw new Error('lost XADD acknowledgement')
          },
        }),
      )
    ).message,
  ).toContain('lost XADD')
  expect(
    (
      await db
        .selectFrom('execution.event_outbox')
        .select('published_at')
        .where('event_id', '=', row.event_id)
        .executeTakeFirstOrThrow()
    ).published_at,
  ).toBeNull()
  expect(await publishEvent(db, { eventID: row.event_id, publish: send })).toBe(
    'published',
  )
  expect(await publishEvent(db, { eventID: row.event_id, publish: send })).toBe(
    'skipped',
  )

  const messages = await read()
  expect(messages).toHaveLength(2)
  expect(messages[0]?.message.delivery).toBe(messages[1]?.message.delivery)
  expect(await consumeEventBatch(db, { commands, messages })).toBe(2)
  expect(
    (
      await readPublicEvents(db, {
        ownerID: 'transport-owner',
        threadID: command.threadID,
      })
    )?.map((event) => event.ordinal),
  ).toEqual([1])
})

test('outbox header mismatch does not send or mark publication', async () => {
  await useEvents()
  const command = await fixture()
  await acceptExecutionCommand(db, command)
  const eventID = crypto.randomUUID()
  await db
    .insertInto('execution.event_outbox')
    .values({
      event_id: eventID,
      thread_id: command.threadID,
      run_id: command.runID,
      ordinal: 1,
      event: {
        version: 1,
        kind: 'run-started',
        eventID: crypto.randomUUID(),
        threadID: command.threadID,
        runID: command.runID,
      },
    })
    .execute()
  expect(
    (
      await rejected(
        publishEvent(db, {
          eventID,
          publish: async (delivery) => {
            await publish({ delivery: JSON.stringify(delivery) })
          },
        }),
      )
    ).message,
  ).toContain('identities')
  expect(entries).toHaveLength(0)
  expect(
    (
      await db
        .selectFrom('execution.event_outbox')
        .select('published_at')
        .where('event_id', '=', eventID)
        .executeTakeFirstOrThrow()
    ).published_at,
  ).toBeNull()
})

test('event acceptance before ACK replays, buffers ordinals and supports cursor reconnect', async () => {
  await useEvents()
  const command = await fixture()
  const first = startedDelivery(command)
  const second: ExecutionDelivery = {
    ordinal: 2,
    event: {
      ...first.event,
      kind: 'assistant-text',
      eventID: crypto.randomUUID(),
      messageID: crypto.randomUUID(),
      delta: 'hi',
    },
  }
  await publish({ delivery: JSON.stringify(second) })
  const messages = await read()
  expect(
    (
      await rejected(
        consumeEventBatch(db, { commands: createClient(), messages }),
      )
    ).message,
  ).toContain('closed')
  expect(await acceptExecutionEvent(db, second)).toBe('accepted')
  expect(
    await readPublicEvents(db, {
      ownerID: 'transport-owner',
      threadID: command.threadID,
    }),
  ).toEqual([])
  expect(await consumeEventBatch(db, { commands, ...(await reclaim()) })).toBe(
    1,
  )

  await publish({ delivery: JSON.stringify(first) })
  expect(
    await consumeEventBatch(db, { commands, messages: await read() }),
  ).toBe(1)
  const visible = await readPublicEvents(db, {
    ownerID: 'transport-owner',
    threadID: command.threadID,
  })
  expect(visible?.map((event) => event.ordinal)).toEqual([1, 2])
  const cursor = visible?.[0]?.cursor
  if (!cursor) throw new Error('Missing cursor')
  expect(
    (
      await readPublicEvents(db, {
        ownerID: 'transport-owner',
        threadID: command.threadID,
        after: cursor,
      })
    )?.map((event) => event.ordinal),
  ).toEqual([2])
})

test('conflicting, unknown-run and invalid deliveries stay pending', async () => {
  await useEvents()
  const command = await fixture()
  const first = startedDelivery(command)
  await acceptExecutionEvent(db, first)
  for (const delivery of [
    { ...first, ordinal: 3 },
    {
      ...first,
      event: {
        ...first.event,
        eventID: crypto.randomUUID(),
        runID: crypto.randomUUID(),
      },
    },
    { ordinal: 0, event: first.event },
  ]) {
    await publish({ delivery: JSON.stringify(delivery) })
    await rejected(consumeEventBatch(db, { commands, messages: await read() }))
  }
  expect((await commands.xPending(stream, group)).pending).toBe(3)
})

test('competing publishers skip a locked event and committed publication is skipped', async () => {
  await useEvents()
  const command = await fixture()
  await acceptExecutionCommand(db, command)
  const delivery = startedDelivery(command)
  await db
    .insertInto('execution.event_outbox')
    .values({
      event_id: delivery.event.eventID,
      thread_id: command.threadID,
      run_id: command.runID,
      ordinal: 1,
      event: sql`${JSON.stringify(delivery.event)}::jsonb`,
    })
    .execute()
  let unlock = () => {}
  let entered = () => {}
  const barrier = new Promise<void>((resolve) => {
    unlock = resolve
  })
  const locked = new Promise<void>((resolve) => {
    entered = resolve
  })
  const publication = publishEvent(db, {
    eventID: delivery.event.eventID,
    publish: async (event) => {
      entered()
      await barrier
      await publish({ delivery: JSON.stringify(event) })
    },
  })
  try {
    await locked
    expect(
      await publishEvent(db, {
        eventID: delivery.event.eventID,
        publish: async () => {
          throw new Error('Locked row was published')
        },
      }),
    ).toBe('skipped')
  } finally {
    unlock()
  }
  expect(await publication).toBe('published')
  expect(entries).toHaveLength(1)
})

test('event run/thread header mismatches and invalid payloads are never published', async () => {
  await useEvents()
  const command = await fixture()
  await acceptExecutionCommand(db, command)
  const delivery = startedDelivery(command)
  await db
    .insertInto('execution.event_outbox')
    .values({
      event_id: delivery.event.eventID,
      thread_id: command.threadID,
      run_id: command.runID,
      ordinal: 1,
      event: sql`${JSON.stringify(delivery.event)}::jsonb`,
    })
    .execute()
  for (const event of [
    { ...delivery.event, runID: crypto.randomUUID() },
    { ...delivery.event, threadID: crypto.randomUUID() },
    { ...delivery.event, version: 2 },
  ]) {
    await db
      .updateTable('execution.event_outbox')
      .set({ event: sql`${JSON.stringify(event)}::jsonb` })
      .where('event_id', '=', delivery.event.eventID)
      .execute()
    await rejected(
      publishEvent(db, {
        eventID: delivery.event.eventID,
        publish: async (item) => {
          await publish({ delivery: JSON.stringify(item) })
        },
      }),
    )
    expect(
      (
        await db
          .selectFrom('execution.event_outbox')
          .select('published_at')
          .where('event_id', '=', delivery.event.eventID)
          .executeTakeFirstOrThrow()
      ).published_at,
    ).toBeNull()
  }
  expect(entries).toHaveLength(0)
})

test('poison delivery diagnostics mask private bytes and leave owned entries pending', async () => {
  await useEvents()
  const privateBytes = 'private-provider-token-do-not-log'
  for (const body of [
    `{"secret":"${privateBytes}",`,
    JSON.stringify({ ordinal: 1, event: { kind: privateBytes } }),
  ]) {
    const id = await publish({ delivery: body })
    const failure = await rejected(
      consumeEventBatch(db, { commands, messages: await read() }),
    )
    expect(failure.message).toBe('Invalid pending delivery payload')
    expect(failure.message).not.toContain(privateBytes)
    const pending = await commands.xPendingRange(stream, group, id, id, 1)
    expect(pending.map((entry) => entry.id)).toEqual([id])
  }
})

test('deleted or missing delivery payloads are explicit errors without ACK', async () => {
  await useEvents()
  const id = await publish({ other: 'not a delivery' })
  expect(
    (
      await rejected(
        consumeEventBatch(db, { commands, messages: await read() }),
      )
    ).message,
  ).toContain('Missing pending delivery')
  expect((await commands.xPending(stream, group)).pending).toBe(1)
  await commands.xDel(stream, id)
  const recovery = await reclaim()
  expect(recovery.deletedMessages).toEqual([id])
  expect(
    (await rejected(consumeEventBatch(db, { commands, ...recovery }))).message,
  ).toContain('Deleted pending delivery')
  expect(
    (await rejected(consumeEventBatch(db, { commands, messages: [null] })))
      .message,
  ).toContain('Deleted pending delivery')
  expect(
    (await rejected(acceptCommandMessages(db, commands, [null]))).message,
  ).toContain('Deleted pending command')
})
