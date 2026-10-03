import { expect, test } from 'bun:test'
import { createClient } from 'redis'
import { createRedisConsumer } from './redis-consumer'

// No sockets are opened: these preconditions must fail before issuing Redis commands.
const commands = createClient()
const blockingReader = createClient()
const subscription = createRedisConsumer({
  commands,
  blockingReader,
  stream: 'unit-test',
  group: 'unit-test',
  consumer: 'unit-test',
})

test('blocking reads cannot share the command connection', () => {
  expect(() =>
    createRedisConsumer({
      commands,
      blockingReader: commands,
      stream: 'unit-test',
      group: 'unit-test',
      consumer: 'unit-test',
    }),
  ).toThrow()
})

test('zero blocking time cannot silently become an indefinite read', () => {
  expect(subscription.readNew({ count: 1, blockMs: 0 })).rejects.toBeInstanceOf(
    RangeError,
  )
})

test('batch sizes must be positive integral Redis bounds', () => {
  expect(
    subscription.readNew({ count: 0, blockMs: 10 }),
  ).rejects.toBeInstanceOf(RangeError)
  expect(
    subscription.reclaim({ minIdleMs: 0, count: 1.5, startID: '0-0' }),
  ).rejects.toBeInstanceOf(RangeError)
})

test('recovery idle eligibility cannot be negative', () => {
  expect(
    subscription.reclaim({ minIdleMs: -1, count: 1, startID: '0-0' }),
  ).rejects.toBeInstanceOf(RangeError)
})
