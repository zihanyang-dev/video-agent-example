import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createClient, type RedisClientType } from 'redis'
import { createRedisConsumer } from '@vid/messaging'

const redisURL = process.env.REDIS_URL
if (!redisURL)
  throw new Error('REDIS_URL is required for messaging integration tests')

let commands: RedisClientType
let reader: RedisClientType
let stream: string
let group: string
let subscription: ReturnType<typeof createRedisConsumer>

// Own one stream per case; cleanup must never reset another consumer's keys or cursor.
beforeEach(async () => {
  stream = `messaging-test:${crypto.randomUUID()}`
  group = `group:${crypto.randomUUID()}`
  commands = createClient({
    url: redisURL,
    socket: { reconnectStrategy: false },
  })
  reader = createClient({ url: redisURL, socket: { reconnectStrategy: false } })
  commands.on('error', console.error)
  reader.on('error', console.error)
  await Promise.all([commands.connect(), reader.connect()])
  subscription = createRedisConsumer({
    commands,
    blockingReader: reader,
    stream,
    group,
    consumer: 'first',
  })
})

afterEach(async () => {
  if (reader?.isOpen) reader.destroy()
  if (!commands?.isOpen) return
  try {
    await commands.del(stream)
  } finally {
    await commands.close()
  }
})

test('group startup includes entries published before startup', async () => {
  const id = await commands.xAdd(stream, '*', { command: 'before startup' })
  await subscription.initialize()
  expect(await subscription.readNew({ count: 1, blockMs: 10 })).toEqual([
    { id, message: { command: 'before startup' } },
  ])
})

test('concurrent initialization keeps the existing group position', async () => {
  await Promise.all([subscription.initialize(), subscription.initialize()])
  await commands.xAdd(stream, '*', { command: 'first' })
  await subscription.readNew({ count: 1, blockMs: 10 })
  await subscription.initialize()
  expect(await subscription.readNew({ count: 1, blockMs: 10 })).toEqual([])
  expect((await commands.xPending(stream, group)).pending).toBe(1)
})

test('initialization propagates failures other than an existing group', async () => {
  await commands.set(stream, 'not a stream')
  expect(subscription.initialize()).rejects.toThrow('WRONGTYPE')
})

test('reading leaves pending work until explicit acknowledgement', async () => {
  await subscription.initialize()
  const id = await commands.xAdd(stream, '*', { command: 'pending' })
  expect(await subscription.readNew({ count: 1, blockMs: 10 })).toEqual([
    { id, message: { command: 'pending' } },
  ])
  expect((await commands.xPending(stream, group)).pending).toBe(1)
  expect(await subscription.readNew({ count: 1, blockMs: 10 })).toEqual([])
  expect(await subscription.acknowledge(id)).toBe(1)
  expect((await commands.xPending(stream, group)).pending).toBe(0)
  expect(await subscription.acknowledge(id)).toBe(0)
  expect(await commands.xLen(stream)).toBe(1)
})

test('reclaim honors idle eligibility and continues from the returned cursor', async () => {
  await subscription.initialize()
  const firstID = await commands.xAdd(stream, '*', { command: 'first' })
  const secondID = await commands.xAdd(stream, '*', { command: 'second' })
  await subscription.readNew({ count: 2, blockMs: 10 })
  const recovery = createRedisConsumer({
    commands,
    blockingReader: reader,
    stream,
    group,
    consumer: 'second',
  })
  expect(
    await recovery.reclaim({ minIdleMs: 60_000, count: 1, startID: '0-0' }),
  ).toMatchObject({
    messages: [],
    deletedMessages: [],
  })
  const first = await recovery.reclaim({
    minIdleMs: 0,
    count: 1,
    startID: '0-0',
  })
  expect(first.messages).toEqual([
    { id: firstID, message: { command: 'first' } },
  ])
  const second = await recovery.reclaim({
    minIdleMs: 0,
    count: 1,
    startID: first.nextId,
  })
  expect(second).toEqual({
    nextId: '0-0',
    messages: [{ id: secondID, message: { command: 'second' } }],
    deletedMessages: [],
  })
  const pending = await commands.xPendingRange(stream, group, '-', '+', 10)
  expect(pending.map((entry) => entry.consumer)).toEqual(['second', 'second'])
})

test('malformed application content remains pending and recoverable', async () => {
  await subscription.initialize()
  const id = await commands.xAdd(stream, '*', {
    command: '{invalid json',
    unexpected: 'raw',
  })
  const messages = [
    { id, message: { command: '{invalid json', unexpected: 'raw' } },
  ]
  expect(await subscription.readNew({ count: 1, blockMs: 10 })).toEqual(
    messages,
  )
  expect((await commands.xPending(stream, group)).pending).toBe(1)
  expect(
    (await subscription.reclaim({ minIdleMs: 0, count: 1, startID: '0-0' }))
      .messages,
  ).toEqual(messages)
})

test('reclaim reports pending entries whose stream bodies were deleted', async () => {
  await subscription.initialize()
  const id = await commands.xAdd(stream, '*', { command: 'deleted' })
  await subscription.readNew({ count: 1, blockMs: 10 })
  await commands.xDel(stream, id)
  expect(
    await subscription.reclaim({ minIdleMs: 0, count: 1, startID: '0-0' }),
  ).toEqual({
    nextId: '0-0',
    messages: [],
    deletedMessages: [id],
  })
  expect((await commands.xPending(stream, group)).pending).toBe(0)
})

test('a server-confirmed blocked read does not block command traffic', async () => {
  await subscription.initialize()
  const readerName = `reader:${crypto.randomUUID()}`
  await reader.clientSetName(readerName)
  const reading = subscription.readNew({ count: 1, blockMs: 2_000 })
  try {
    await waitForBlockedReader(readerName)
    expect(await commands.ping()).toBe('PONG')
    const id = await commands.xAdd(stream, '*', { command: 'unblock' })
    expect(await reading).toEqual([{ id, message: { command: 'unblock' } }])
  } finally {
    await reading
  }
})

async function waitForBlockedReader(name: string): Promise<void> {
  // Observe Redis's blocked-client flag rather than infer readiness from a fixed sleep.
  for (let attempt = 0; attempt < 50; attempt++) {
    const clients = await commands.clientList()
    if (
      clients.some(
        (client) => client.name === name && client.flags.includes('b'),
      )
    )
      return
    await Bun.sleep(10)
  }
  throw new Error('Reader did not enter a server-side blocking read')
}
