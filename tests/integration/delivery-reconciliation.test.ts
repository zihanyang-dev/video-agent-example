import { executionDeliverySchema } from '@vid/contract/execution'
import { inspectDelivery } from '../../scripts/reconcile-deliveries'
import { publishEvent } from '../../apps/agent/src/execution/db/event-publication'
import { acceptExecutionEvent, readPublicEvents } from '../../apps/server/src/db/execution-events'
import { afterAll, expect, test } from 'bun:test'
import { createClient, type RedisClientType } from 'redis'
import { executionCommandSchema, type StartCommand } from '@vid/contract/execution'
import { publishCommand } from '../../apps/server/src/db/command-publication'
import { acceptMessageIntent } from '../../apps/server/src/db/submissions'
import { acceptExecutionCommand } from '../../apps/agent/src/execution/db/command-acceptance'
import { openTestDatabase, seedTestUser } from './database-fixture'

const redisURL = process.env.REDIS_URL
if (!redisURL) throw new Error('Owned REDIS_URL required')
const { db, close } = openTestDatabase()
const threads: string[] = []
afterAll(async () => {
  try {
    if (!threads.length) return
    for (const table of [
      'execution.event_outbox',
      'execution.runs',
      'execution.command_inbox',
      'execution.conversations',
      'product.execution_events',
      'product.command_outbox',
      'product.messages',
      'product.threads',
    ] as const) {
      await db.deleteFrom(table).where('thread_id', 'in', threads).execute()
    }
  } finally {
    await close()
  }
})

async function fixture(): Promise<StartCommand> {
  const command: StartCommand = {
    version: 1,
    kind: 'start',
    commandID: crypto.randomUUID(),
    threadID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    input: { messageID: crypto.randomUUID(), text: 'original retained input' },
  }
  threads.push(command.threadID)
  await seedTestUser(db, 'reconciliation-owner')
  await db
    .insertInto('product.threads')
    .values({ thread_id: command.threadID, owner_id: 'reconciliation-owner' })
    .execute()
  await acceptMessageIntent(db, {
    ownerID: 'reconciliation-owner',
    threadID: command.threadID,
    runID: command.runID,
    commandID: command.commandID,
    messageID: command.input.messageID,
    text: command.input.text,
  })
  return command
}

async function closeOwnedEntries(redis: RedisClientType, stream: string, ids: string[]) {
  if (!redis.isOpen) return
  try {
    if (ids.length) await redis.xDel(stream, ids)
  } finally {
    await redis.close()
  }
}

test('acknowledged XADD loss before acceptance strands published command; read-only inspection and same-ID redelivery accept once', async () => {
  const command = await fixture()
  const redis = createClient({
    url: redisURL,
    socket: { reconnectStrategy: false, connectTimeout: 5000 },
  })
  const stream = `reconciliation-proof:${crypto.randomUUID()}`
  const ids: string[] = []
  redis.on('error', () => {})
  try {
    await redis.connect()
    const send = async (value: StartCommand | ReturnType<typeof executionCommandSchema.parse>) => {
      ids.push(await redis.xAdd(stream, '*', { command: JSON.stringify(value) }))
    }
    expect(await publishCommand(db, { commandID: command.commandID, publish: send })).toBe(
      'published',
    )
    const first = (await redis.xRange(stream, ids[0]!, ids[0]!)) ?? []
    expect(first).toHaveLength(1)
    expect(await redis.xDel(stream, ids[0]!)).toBe(1)
    expect(await publishCommand(db, { commandID: command.commandID, publish: send })).toBe(
      'skipped',
    )
    expect(
      await db
        .selectFrom('execution.command_inbox')
        .selectAll()
        .where('command_id', '=', command.commandID)
        .execute(),
    ).toEqual([])
    const before = await inspectDelivery(db, 'command', command.commandID)
    expect(before.sender?.published_at).not.toBeNull()
    expect(before.receiver).toBeUndefined()
    // Test-only same-envelope redelivery; no administrative sender mutation.
    await send(command)
    const resent = (await redis.xRange(stream, ids[1]!, ids[1]!)) ?? []
    expect(resent[0]?.message.command).toBe(first[0]?.message.command)
    const received = executionCommandSchema.parse(JSON.parse(resent[0]!.message.command!))
    expect(await acceptExecutionCommand(db, received)).toBe('accepted')
    expect(await acceptExecutionCommand(db, received)).toBe('replay')
    const after = await inspectDelivery(db, 'command', command.commandID)
    expect(after.sender).toEqual(before.sender)
    expect(after.receiver).toHaveProperty('command_id', command.commandID)
    expect(
      await db
        .selectFrom('execution.runs')
        .select('status')
        .where('run_id', '=', command.runID)
        .execute(),
    ).toEqual([{ status: 'queued' }])
  } finally {
    await closeOwnedEntries(redis, stream, ids)
  }
})

test('acknowledged event XADD loss redelivers original terminal and ordinal, preserves status and replay cursor', async () => {
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
  const redis = createClient({
    url: redisURL,
    socket: { reconnectStrategy: false, connectTimeout: 5000 },
  })
  redis.on('error', () => {})
  const stream = `reconciliation-event-proof:${crypto.randomUUID()}`
  const ids: string[] = []
  try {
    await redis.connect()
    const send = async (delivery: ReturnType<typeof executionDeliverySchema.parse>) => {
      ids.push(await redis.xAdd(stream, '*', { delivery: JSON.stringify(delivery) }))
    }
    expect(await publishEvent(db, { eventID: row.event_id, publish: send })).toBe('published')
    const first = (await redis.xRange(stream, ids[0]!, ids[0]!)) ?? []
    expect(first).toHaveLength(1)
    expect(await redis.xDel(stream, ids[0]!)).toBe(1)
    expect(await publishEvent(db, { eventID: row.event_id, publish: send })).toBe('skipped')
    expect(
      await db
        .selectFrom('product.execution_events')
        .selectAll()
        .where('event_id', '=', row.event_id)
        .execute(),
    ).toEqual([])
    const before = await inspectDelivery(db, 'event', row.event_id)
    expect(before.sender?.published_at).not.toBeNull()
    expect(before.receiver).toBeUndefined()
    await send(executionDeliverySchema.parse({ ordinal: row.ordinal, event: row.event }))
    const resent = (await redis.xRange(stream, ids[1]!, ids[1]!)) ?? []
    expect(resent[0]?.message.delivery).toBe(first[0]?.message.delivery)
    const received = executionDeliverySchema.parse(JSON.parse(resent[0]!.message.delivery!))
    expect(await acceptExecutionEvent(db, received)).toBe('accepted')
    const replay = await readPublicEvents(db, {
      ownerID: 'reconciliation-owner',
      threadID: command.threadID,
    })
    expect(replay).toHaveLength(1)
    expect(replay?.[0]?.event.kind).toBe('run-cancelled')
    expect(await acceptExecutionEvent(db, received)).toBe('accepted')
    expect(
      await readPublicEvents(db, {
        ownerID: 'reconciliation-owner',
        threadID: command.threadID,
      }),
    ).toEqual(replay)
    const after = await inspectDelivery(db, 'event', row.event_id)
    expect(after.sender).toEqual(before.sender)
    expect(after.receiver).toHaveProperty('event_id', row.event_id)
    expect(
      await db
        .selectFrom('execution.runs')
        .select('status')
        .where('run_id', '=', command.runID)
        .execute(),
    ).toEqual([{ status: 'cancelled' }])
    expect(
      await db
        .selectFrom('execution.conversations')
        .select('native_sandbox')
        .where('thread_id', '=', command.threadID)
        .execute(),
    ).toEqual([{ native_sandbox: null }])
  } finally {
    await closeOwnedEntries(redis, stream, ids)
  }
})
