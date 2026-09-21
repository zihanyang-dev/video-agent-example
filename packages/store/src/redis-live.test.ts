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

describe('a browser that fell further behind than the window', () => {
  test('is told, so it can be sent the conversation again', async () => {
    await live.publish(thread, delta('what it missed'))

    // What trimming leaves behind: the reader's position is older than anything still held.
    await admin.send('XTRIM', [`live:${thread}`, 'MINID', String(Date.now())])
    await live.publish(thread, delta('what came after'))

    const reachable = await live.reachable({ thread, after: '1-0' })

    // Resuming from here would succeed quietly and leave a hole in the page.
    expect(reachable).toBe(false)
  })

  test('is left alone when its position is still in the stream', async () => {
    await live.publish(thread, delta('one'))
    const seen: { id: string; event: Event }[] = []
    const stop = new AbortController()
    await collect(live.read({ thread, after: null }, stop.signal), seen, 1)
    stop.abort()

    expect(await live.reachable({ thread, after: seen[0]!.id })).toBe(true)
  })

  test('starting from the beginning is always fine', async () => {
    await live.publish(thread, delta('one'))

    expect(await live.reachable({ thread, after: null })).toBe(true)
  })

  test('a position into a stream with nothing left in it is not reachable either', async () => {
    // Everything this reader saw has been trimmed. We cannot show it is caught up, so it
    // is not treated as caught up.
    expect(await live.reachable({ thread, after: '1-0' })).toBe(false)
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
