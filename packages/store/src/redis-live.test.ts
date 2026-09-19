/**
 * What the stream is for: a browser that lost its connection picks up where it left off,
 * and nothing that is not an event reaches it.
 *
 * Needs `docker compose -f deploy/docker/compose.yaml up -d redis`.
 */
import { EventType, type Event } from '@ag-ui/core'
import { RedisClient } from 'bun'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createRedisLiveStream } from './redis-live'

const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379'
const live = createRedisLiveStream(url)
const admin = new RedisClient(url)

let thread = ''

beforeEach(() => {
  thread = `t-${crypto.randomUUID()}`
})

afterAll(() => {
  admin.close()
  live.close()
})

const delta = (text: string): Event => ({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: 'm1',
  delta: text,
})

/** Reads until it has `want` events or `within` passes, whichever is first. */
const readUpTo = async (
  want: number,
  after: string | null,
  within = 3_000,
): Promise<{ id: string; event: Event }[]> => {
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), within)
  const got: { id: string; event: Event }[] = []

  // Aborting is how a read that found nothing ends, so it is an outcome rather than a
  // failure.
  await collect(live.read({ thread, after }, stop.signal), got, want).catch(() => {})
  clearTimeout(timer)
  stop.abort()
  return got
}

const collect = async (
  entries: AsyncIterable<{ id: string; event: Event }>,
  into: { id: string; event: Event }[],
  want: number,
): Promise<void> => {
  for await (const entry of entries) {
    into.push(entry)
    if (into.length === want) return
  }
}

const deltasOf = (entries: readonly { event: Event }[]): string[] =>
  entries.map((entry) => String((entry.event as { delta?: string }).delta))

describe('reading what was published', () => {
  test('everything, in the order it was written', async () => {
    await live.publish(thread, delta('one'))
    await live.publish(thread, delta('two'))
    await live.publish(thread, delta('three'))

    expect(deltasOf(await readUpTo(3, null))).toEqual(['one', 'two', 'three'])
  })

  test('every event has a position', async () => {
    await live.publish(thread, delta('one'))

    const [first] = await readUpTo(1, null)
    expect(first?.id).toMatch(/^\d+-\d+$/)
  })

  test('a reader already waiting receives a later write', async () => {
    await live.publish(thread, delta('one'))
    const [first] = await readUpTo(1, null)

    const waiting = readUpTo(1, first!.id)
    await Bun.sleep(150)
    await live.publish(thread, delta('two'))

    expect(deltasOf(await waiting)).toEqual(['two'])
  })
})

describe('a browser that came back', () => {
  test('resuming from a position skips what it already had', async () => {
    await live.publish(thread, delta('one'))
    await live.publish(thread, delta('two'))
    await live.publish(thread, delta('three'))
    const seen = await readUpTo(3, null)

    const missed = await readUpTo(2, seen[0]!.id)

    expect(deltasOf(missed)).toEqual(['two', 'three'])
  })
})

describe('something that is not one of our events', () => {
  const rubbish = [
    ['not json at all', 'not json at all'],
    ['json that is not an event', JSON.stringify({ type: 'NOT_A_REAL_EVENT' })],
    ['an event missing its fields', JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT' })],
  ] as const

  test('is dropped, and the stream carries on past it', async () => {
    await live.publish(thread, delta('one'))
    for (const [, payload] of rubbish) {
      await admin.send('XADD', [`live:${thread}`, '*', 'event', payload])
    }
    await live.publish(thread, delta('two'))

    // Asking for three proves only two exist: the read ends on its own deadline.
    expect(deltasOf(await readUpTo(3, null))).toEqual(['one', 'two'])
  })
})
