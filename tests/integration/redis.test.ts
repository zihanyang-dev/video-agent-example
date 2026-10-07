import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createClient, type RedisClientType } from 'redis'
import { connectRedisFixture, destroyRedisFixture } from './redis-connection-fixture'

const redisURL = process.env.REDIS_URL
if (!redisURL) throw new Error('Dedicated REDIS_URL required')
let commands: RedisClientType
let reader: RedisClientType
let stream: string
let group: string
let admitted = false

beforeEach(async () => {
  admitted = false
  stream = `redis-test:${crypto.randomUUID()}`
  group = `group:${crypto.randomUUID()}`
  commands = createClient({
    url: redisURL,
    socket: { reconnectStrategy: false },
  })
  reader = createClient({ url: redisURL, socket: { reconnectStrategy: false } })
  await connectRedisFixture(commands, reader)
  admitted = true
})
afterEach(async () => {
  const failures: unknown[] = []
  if (admitted)
    await commands.del(stream).catch((cause: unknown) => {
      failures.push(cause)
    })
  failures.push(...destroyRedisFixture(commands, reader))
  if (failures.length) throw new AggregateError(failures, 'Owned Redis cleanup failed')
})

async function initialize() {
  try {
    await commands.xGroupCreate(stream, group, '0-0', { MKSTREAM: true })
  } catch (cause) {
    if (!(cause instanceof Error) || !cause.message.startsWith('BUSYGROUP ')) throw cause
  }
}
async function read(count = 1, blockMs = 10) {
  const pages = await reader.xReadGroup(
    group,
    'first',
    { key: stream, id: '>' },
    { COUNT: count, BLOCK: blockMs },
  )
  return pages?.flatMap((page) => page.messages) ?? []
}

test('native group initialization retains earlier entries and existing group position', async () => {
  const id = await commands.xAdd(stream, '*', { command: 'before startup' })
  await Promise.all([initialize(), initialize()])
  expect(await read()).toEqual([{ id, message: { command: 'before startup' } }])
  await initialize()
  expect(await read()).toEqual([])
  expect((await commands.xPending(stream, group)).pending).toBe(1)
})

test('native initialization propagates errors other than an existing group', async () => {
  await commands.set(stream, 'not a stream')
  const failure = await initialize().catch((cause: unknown) => cause)
  expect(failure).toBeInstanceOf(Error)
  expect(failure instanceof Error && failure.message).toContain('WRONGTYPE')
})

test('native read keeps pending work until explicit ACK, and ACK does not delete bytes', async () => {
  await initialize()
  const id = await commands.xAdd(stream, '*', { command: 'pending' })
  expect(await read()).toEqual([{ id, message: { command: 'pending' } }])
  expect((await commands.xPending(stream, group)).pending).toBe(1)
  expect(await read()).toEqual([])
  expect(await commands.xAck(stream, group, id)).toBe(1)
  expect((await commands.xPending(stream, group)).pending).toBe(0)
  expect(await commands.xAck(stream, group, id)).toBe(0)
  expect(await commands.xLen(stream)).toBe(1)
})

test('native reclaim honors idle eligibility, cursor continuation and consumer ownership', async () => {
  await initialize()
  const firstID = await commands.xAdd(stream, '*', { command: 'first' })
  const secondID = await commands.xAdd(stream, '*', { command: 'second' })
  await read(2)
  expect(
    await commands.xAutoClaim(stream, group, 'second', 60000, '0-0', {
      COUNT: 1,
    }),
  ).toMatchObject({ messages: [], deletedMessages: [] })
  const first = await commands.xAutoClaim(stream, group, 'second', 0, '0-0', {
    COUNT: 1,
  })
  expect(first.messages).toEqual([{ id: firstID, message: { command: 'first' } }])
  expect(
    await commands.xAutoClaim(stream, group, 'second', 0, first.nextId, {
      COUNT: 1,
    }),
  ).toEqual({
    nextId: '0-0',
    messages: [{ id: secondID, message: { command: 'second' } }],
    deletedMessages: [],
  })
  const pending = await commands.xPendingRange(stream, group, '-', '+', 10)
  expect(pending.map((entry) => entry.consumer)).toEqual(['second', 'second'])
})

test('native reclaim preserves malformed application content and explicitly reports deleted bodies', async () => {
  await initialize()
  const id = await commands.xAdd(stream, '*', {
    command: '{invalid json',
    unexpected: 'raw',
  })
  const messages = [{ id, message: { command: '{invalid json', unexpected: 'raw' } }]
  expect(await read()).toEqual(messages)
  expect((await commands.xPending(stream, group)).pending).toBe(1)
  expect(
    (await commands.xAutoClaim(stream, group, 'second', 0, '0-0', { COUNT: 1 })).messages,
  ).toEqual(messages)
  await commands.xDel(stream, id)
  expect(await commands.xAutoClaim(stream, group, 'second', 0, '0-0', { COUNT: 1 })).toEqual({
    nextId: '0-0',
    messages: [],
    deletedMessages: [id],
  })
  expect((await commands.xPending(stream, group)).pending).toBe(0)
})

test('a server-confirmed blocked native reader does not block command traffic', async () => {
  await initialize()
  const readerName = `reader:${crypto.randomUUID()}`
  await reader.clientSetName(readerName)
  const reading = read(1, 2000)
  try {
    let blocked = false
    for (let attempt = 0; attempt < 50 && !blocked; attempt++) {
      const clients = await commands.clientList()
      blocked = clients.some((client) => client.name === readerName && client.flags.includes('b'))
      await Bun.sleep(blocked ? 0 : 10)
    }
    expect(blocked).toBeTrue()
    expect(await commands.ping()).toBe('PONG')
    const id = await commands.xAdd(stream, '*', { command: 'unblock' })
    expect(await reading).toEqual([{ id, message: { command: 'unblock' } }])
  } finally {
    await reading
  }
})
