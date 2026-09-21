/**
 * What a browser can ask for, and what it must not be able to.
 *
 * The stream cases are the reason the whole thing is a Redis stream rather than a channel:
 * a first connection opens with what was stored, and a reconnect gets only what it missed.
 *
 * Needs Postgres and Redis up, and `bun run migrate`.
 */
import { EventType, type Event } from '@ag-ui/core'
import type { TurnRequest } from '@vid/queue'
import { createPostgresMessages, createRedisLiveStream } from '@vid/store'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createRoutes } from './routes'

const sql = new SQL(process.env['DATABASE_URL'] ?? 'postgres://vid:vid@localhost:5432/vid')
const live = createRedisLiveStream(process.env['REDIS_URL'] ?? 'redis://localhost:6379')
const messages = createPostgresMessages(sql)

const thread = `t-${crypto.randomUUID()}`
const queued: TurnRequest[] = []

const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  fetch: createRoutes({
    queue: {
      put: async (turn) => {
        queued.push(turn)
      },
      take: async () => {},
      close: async () => {},
    },
    messages,
    live,
    readerOf: async (request) => {
      const userID = request.headers.get('x-user-id')
      return userID === null || userID === '' ? null : { userID }
    },
    sign: async (key: string) => `https://objects.example/${key}?signed`,
    newTurnID: () => 'turn-fixed',
    newThreadID: () => 'thread-fixed',
  }).fetch,
})

beforeAll(async () => {
  await sql`insert into threads (thread_id, user_id) values (${thread}, ${'owner'})`
  await messages.append(thread, { id: 'm0', role: 'assistant', content: 'said yesterday' })
})

afterAll(async () => {
  server.stop(true)
  live.close()
  await sql`delete from threads where thread_id in (${thread}, ${'thread-fixed'})`
  await sql.close()
})

const at = (path: string): string => `http://localhost:${server.port}${path}`
const owner = { 'x-user-id': 'owner', 'content-type': 'application/json' }

const speak = (headers: Record<string, string>, message: unknown): Promise<Response> =>
  fetch(at(`/threads/${thread}/messages`), {
    method: 'POST',
    headers,
    body: JSON.stringify({ message }),
  })

const delta = (messageId: string, text: string): Event => ({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId,
  delta: text,
})

/** Publishes after a moment, so a reader is already waiting when it lands. */
const publishShortly = (messageId: string, texts: readonly string[]): void => {
  void (async () => {
    await Bun.sleep(150)
    for (const text of texts) await live.publish(thread, delta(messageId, text))
  })()
}

/** Reads SSE frames until it has `want` of them or the deadline passes. */
const frames = async (headers: Record<string, string>, want: number, then?: () => void) => {
  const response = await fetch(at(`/threads/${thread}/events`), { headers })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + 3_000
  let buffer = ''
  const found: string[] = []
  then?.()

  while (found.length < want && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    found.push(...parts.filter((part) => part.trim() !== ''))
  }
  await reader.cancel()
  return found
}

describe('starting a conversation', () => {
  test('gives back an id the caller did not choose, owned by whoever asked', async () => {
    const response = await fetch(at('/threads'), { method: 'POST', headers: owner })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ threadID: 'thread-fixed' })
    expect(await messages.thread('thread-fixed')).toEqual({
      threadID: 'thread-fixed',
      userID: 'owner',
    })
  })

  test('is not something a stranger off the street can do', async () => {
    expect((await fetch(at('/threads'), { method: 'POST' })).status).toBe(401)
  })
})

describe('who is asking', () => {
  test('no session gets nothing', async () => {
    expect((await speak({}, 'hello')).status).toBe(401)
  })

  test('someone else’s conversation is not theirs to read', async () => {
    const response = await speak({ ...owner, 'x-user-id': 'stranger' }, 'let me in')

    expect(response.status).toBe(404)
  })

  test('a conversation that never existed answers the same way', async () => {
    const mine = await speak({ ...owner, 'x-user-id': 'stranger' }, 'let me in')
    const absent = await fetch(at('/threads/never-existed/messages'), {
      method: 'POST',
      headers: owner,
      body: JSON.stringify({ message: 'hello' }),
    })

    // Telling them apart would let anyone learn which conversations exist by asking.
    expect(absent.status).toBe(mine.status)
    expect(await absent.text()).toBe(await mine.clone().text())
  })
})

describe('saying something', () => {
  test.each([
    ['nothing but spaces', '   '],
    ['not a string at all', 42],
  ])('%s is refused', async (_name, message) => {
    expect((await speak(owner, message)).status).toBe(400)
  })

  test('is accepted rather than waited for', async () => {
    const response = await speak(owner, 'cut me a montage')

    // A turn runs for minutes; a request that lived that long would hold a connection open
    // across a deploy.
    expect(response.status).toBe(202)
    expect(queued.at(-1)).toMatchObject({ threadID: thread, message: 'cut me a montage' })
  })
})

describe('the event stream', () => {
  test('a first connection opens with the conversation as it stands', async () => {
    const [first] = await frames({ 'x-user-id': 'owner' }, 1)

    expect(first).toContain('MESSAGES_SNAPSHOT')
    expect(first).toContain('said yesterday')
  })

  test('live events follow, each carrying its position', async () => {
    const seen = await frames({ 'x-user-id': 'owner' }, 3, () => {
      publishShortly('m1', ['one', 'two'])
    })

    expect(seen.some((frame) => frame.includes('"one"'))).toBe(true)
    expect(seen.filter((frame) => frame.startsWith('id: ')).length).toBeGreaterThanOrEqual(2)
  })

  test('a browser that came back gets what it missed and not what it had', async () => {
    const seen = await frames({ 'x-user-id': 'owner' }, 3, () => {
      publishShortly('m2', ['a', 'b'])
    })
    const firstPosition = seen
      .find((frame) => frame.startsWith('id: '))!
      .split('\n')[0]!
      .slice(4)

    const resumed = await frames({ 'x-user-id': 'owner', 'last-event-id': firstPosition }, 1)

    expect(resumed.some((frame) => frame.includes('MESSAGES_SNAPSHOT'))).toBe(false)
  })
})
