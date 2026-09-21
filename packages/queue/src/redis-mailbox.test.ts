import { expect, test } from 'bun:test'
import { RedisClient } from 'bun'
import { createRedisMailbox } from './redis-mailbox'

const url = 'redis://localhost:6379'

test('a new consumer receives messages published before its group existed', async () => {
  const stream = `test:${crypto.randomUUID()}`
  const mailbox = createRedisMailbox({ url, stream, group: 'workers', consumer: 'one' })
  const stopping = new AbortController()
  const received: unknown[] = []

  await mailbox.publish({ message: 'persisted' })

  const consumption = mailbox.consume(async (body) => {
    received.push(body)
    stopping.abort()
    return true
  }, stopping.signal)

  try {
    await consumption
  } finally {
    mailbox.close()
    const redis = new RedisClient(url)
    await redis.del(stream)
    redis.close()
  }

  expect(received).toEqual([{ message: 'persisted' }])
})

test('an unacknowledged delivery is reclaimed by another worker', async () => {
  const stream = `test:${crypto.randomUUID()}`
  const first = createRedisMailbox({ url, stream, group: 'workers', consumer: 'lost' })
  const firstStop = new AbortController()
  await first.publish({ command: 'retry' })
  await first.consume(async () => {
    firstStop.abort()
    return false
  }, firstStop.signal)
  first.close()

  const second = createRedisMailbox({ url, stream, group: 'workers', consumer: 'replacement' })
  const secondStop = new AbortController()
  const received: unknown[] = []

  try {
    await second.consume(async (body) => {
      received.push(body)
      secondStop.abort()
      return true
    }, secondStop.signal)
  } finally {
    second.close()
    const redis = new RedisClient(url)
    await redis.del(stream)
    redis.close()
  }

  expect(received).toEqual([{ command: 'retry' }])
}, 5000)
