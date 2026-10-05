import { afterAll, expect, test } from 'bun:test'
import {
  createThread,
  getThread,
  listMessages,
  submitMessage,
  logout,
} from '@vid/contract/client'
import { createClient } from '@vid/contract/fetch'
import { messagesResponseSchema } from '@vid/contract/http'
import { sha256 } from '@vid/object-storage'
import { EventSchema } from '@ag-ui/core/schemas'
import { EventType } from '@ag-ui/core'
// Resolve the published browser SDK from its actual consumer workspace; this
// integration fixture imports no web source or private browser implementation.
import { HttpAgent } from '@ag-ui/client'
import { signedTestIdentity, serverTestEnv } from './authentication-fixture'
import { sql } from 'kysely'
import { startServer } from '../../apps/server/src/server'
import { createHTTP } from '../../apps/server/src/http'
import {
  acceptExecutionEvent,
  readPublicEvents,
} from '../../apps/server/src/db/execution-events'
import { openTestDatabase } from './database-fixture'

const { db, close } = openTestDatabase()
const login = await signedTestIdentity(db)
const other = await signedTestIdentity(db)
const shutdown = new AbortController()
const handle = createHTTP(db, {
  authentication: login.authentication,
  signal: shutdown.signal,
  pollIntervalMs: 5,
})
const threads: string[] = []
afterAll(async () => {
  shutdown.abort()
  if (threads.length) {
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
      .deleteFrom('product.assets')
      .where('thread_id', 'in', threads)
      .execute()
    await db
      .deleteFrom('product.threads')
      .where('thread_id', 'in', threads)
      .execute()
  }
  await close()
})
async function request(path: string, body?: unknown, headers?: HeadersInit) {
  return await handle(
    new Request(`http://127.0.0.1:8787${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        ...Object.fromEntries(login.headers),
        ...Object.fromEntries(new Headers(headers)),
      },
    }),
  )
}
async function thread() {
  const response = await request('/api/threads', {
    threadID: crypto.randomUUID(),
    title: 'Test chat',
  })
  expect(response.status).toBe(201)
  const value: { thread: { threadID: string } } = await response.json()
  threads.push(value.thread.threadID)
  return value.thread.threadID
}
async function submit(threadID: string) {
  const body = { messageID: crypto.randomUUID(), text: ' Hello ' }
  const response = await request(`/api/threads/${threadID}/messages`, body)
  expect(response.status).toBe(202)
  const value: { runID: string; commandID: string; messageID: string } =
    await response.json()
  return { body, value }
}
function observe(threadID: string, runID: string) {
  return {
    threadId: threadID,
    runId: runID,
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  }
}

test('owned thread snapshots, durable submission replay and malformed input', async () => {
  const id = await thread()
  expect((await request(`/api/threads/${id}`)).status).toBe(200)
  const { body, value } = await submit(id)
  expect(
    await (await request(`/api/threads/${id}/messages`, body)).json(),
  ).toEqual(value)
  expect(
    (
      await request(`/api/threads/${id}/messages`, {
        ...body,
        text: 'different',
      })
    ).status,
  ).toBe(409)
  expect(
    (
      await request(`/api/threads/${id}/messages`, {
        messageID: 'bad',
        text: 'hello',
      })
    ).status,
  ).toBe(400)
  expect(
    (await request(`/api/threads/${id}/runs/${value.runID}/events`, {})).status,
  ).toBe(400)
  expect(
    await (await request(`/api/threads/${id}/messages`)).json(),
  ).toMatchObject({
    messages: [{ messageID: body.messageID, role: 'user', text: 'Hello' }],
  })
  expect(await (await request('/api/threads')).json()).toMatchObject({
    threads: expect.arrayContaining([
      expect.objectContaining({ threadID: id }),
    ]),
  })
})

test('unknown and foreign threads and runs have identical unavailable responses', async () => {
  const id = await thread()
  const { value } = await submit(id)
  const foreign = createHTTP(db, {
    authentication: other.authentication,
    pollIntervalMs: 5,
    signal: shutdown.signal,
  })
  for (const suffix of ['', '/messages']) {
    const a = await foreign(
      new Request(`http://local/api/threads/${id}${suffix}`, {
        headers: other.headers,
      }),
    )
    const b = await request(`/api/threads/${crypto.randomUUID()}${suffix}`)
    expect(a.status).toBe(404)
    expect(await a.text()).toBe(await b.text())
  }
  const unknownRunID = crypto.randomUUID()
  expect(
    (
      await request(
        `/api/threads/${id}/runs/${unknownRunID}/events`,
        observe(id, unknownRunID),
      )
    ).status,
  ).toBe(404)
  expect(
    (
      await foreign(
        new Request(
          `http://local/api/threads/${id}/runs/${value.runID}/events`,
          {
            method: 'POST',
            headers: other.headers,
            body: JSON.stringify(observe(id, value.runID)),
          },
        ),
      )
    ).status,
  ).toBe(404)
})

test('cancel is authorized, replayable and never creates product messages', async () => {
  const id = await thread()
  const { value } = await submit(id)
  const body = { commandID: crypto.randomUUID(), runID: value.runID }
  const first = await request(`/api/threads/${id}/runs/${body.runID}/cancel`, {
    commandID: body.commandID,
  })
  expect(first.status).toBe(202)
  expect(
    await (
      await request(`/api/threads/${id}/runs/${body.runID}/cancel`, {
        commandID: body.commandID,
      })
    ).json(),
  ).toEqual(await first.json())
  expect(
    (
      await request(`/api/threads/${id}/runs/${crypto.randomUUID()}/cancel`, {
        commandID: body.commandID,
      })
    ).status,
  ).toBe(404)
  const second = await submit(id)
  expect(
    (
      await request(`/api/threads/${id}/runs/${second.value.runID}/cancel`, {
        commandID: body.commandID,
      })
    ).status,
  ).toBe(409)
  expect(
    (
      await db
        .selectFrom('product.messages')
        .selectAll()
        .where('thread_id', '=', id)
        .execute()
    ).length,
  ).toBe(2)
})

test('official SSE completion emits full text once, final-frame cursor and durable replay', async () => {
  const id = await thread()
  const { value } = await submit(id)
  const messageID = crypto.randomUUID()
  for (const [ordinal, fact] of [
    [1, { kind: 'run-started' }],
    [2, { kind: 'assistant-text', messageID, delta: 'Hello' }],
    [3, { kind: 'run-completed', messageID, text: 'Hello world' }],
  ] as const) {
    expect(
      await acceptExecutionEvent(db, {
        ordinal,
        event: {
          version: 1,
          eventID: crypto.randomUUID(),
          threadID: id,
          runID: value.runID,
          ...fact,
        },
      }),
    ).toBe('accepted')
  }
  const response = await request(
    `/api/threads/${id}/runs/${value.runID}/events`,
    observe(id, value.runID),
  )
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const text = await response.text()
  const frames = text.trim().split('\n\n')
  const events = frames.map((frame) =>
    EventSchema.parse(
      JSON.parse(
        frame
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6) ?? 'null',
      ),
    ),
  )
  expect(
    events
      .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
      .map((e) => e.delta)
      .join(''),
  ).toBe('Hello world')
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(frames.filter((f) => f.includes('id: '))).toHaveLength(2)
  const cursor = lastFactCursor(text)
  const replay = await request(
    `/api/threads/${id}/runs/${value.runID}/events`,
    {
      ...observe(id, value.runID),
      forwardedProps: { after: cursor },
    },
  )
  expect(await replay.text()).toContain('RUN_STARTED')
})

test.each(['run-cancelled', 'run-failed'] as const)(
  'prestart %s terminates and disconnect does not cancel execution',
  async (kind) => {
    const id = await thread()
    const { value } = await submit(id)
    const pending = await request(
      `/api/threads/${id}/runs/${value.runID}/events`,
      observe(id, value.runID),
    )
    await pending.body?.cancel()
    expect(
      await db
        .selectFrom('product.command_outbox')
        .selectAll()
        .where('thread_id', '=', id)
        .execute(),
    ).toHaveLength(1)
    const event = {
      version: 1,
      eventID: crypto.randomUUID(),
      threadID: id,
      runID: value.runID,
    } as const
    await acceptExecutionEvent(db, {
      ordinal: 1,
      event:
        kind === 'run-failed'
          ? { ...event, kind, reason: 'execution-error' }
          : { ...event, kind },
    })
    const response = await request(
      `/api/threads/${id}/runs/${value.runID}/events`,
      observe(id, value.runID),
    )
    expect(await response.text()).toContain(
      kind === 'run-failed' ? 'RUN_ERROR' : 'RUN_FINISHED',
    )
  },
)

async function readFirstFact(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing stream')
  try {
    let text = ''
    while (!text.includes('\nid: '))
      text += new TextDecoder().decode((await reader.read()).value)
    return text
  } finally {
    await reader.cancel()
  }
}

async function emitText(
  identities: { threadID: string; runID: string; messageID: string },
  ordinal: number,
  fact:
    | { kind: 'assistant-text'; delta: string }
    | { kind: 'run-completed'; text: string },
) {
  expect(
    await acceptExecutionEvent(db, {
      ordinal,
      event: {
        version: 1,
        eventID: crypto.randomUUID(),
        ...identities,
        ...fact,
      },
    }),
  ).toBe('accepted')
}

async function assertCompletedSnapshot(id: string, messageID: string) {
  expect(
    await db
      .selectFrom('product.command_outbox')
      .selectAll()
      .where('thread_id', '=', id)
      .execute(),
  ).toHaveLength(1)
  expect(
    await (await request(`/api/threads/${id}/messages`)).json(),
  ).toMatchObject({
    messages: expect.arrayContaining([
      expect.objectContaining({
        messageID,
        role: 'assistant',
        text: 'Hello world',
      }),
    ]),
  })
}

test('live deltas resume at durable cursor without duplicating completion and ignore browser history', async () => {
  const id = await thread()
  const { value } = await submit(id)
  const messageID = crypto.randomUUID()
  await emitText({ threadID: id, runID: value.runID, messageID }, 1, {
    kind: 'assistant-text',
    delta: 'Hello',
  })
  const response = await request(
    `/api/threads/${id}/runs/${value.runID}/events`,
    {
      ...observe(id, value.runID),
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          content: 'replace private history',
        },
      ],
      state: { private: 'override' },
    },
  )
  const first = await readFirstFact(response)
  const cursor = first
    .split('\n')
    .find((line) => line.startsWith('id: '))
    ?.slice(4)
  if (!cursor) throw new Error('Missing durable cursor')
  const frames = first.trim().split('\n\n')
  expect(frames).toHaveLength(3)
  expect(frames.slice(0, -1).every((frame) => !frame.includes('id: '))).toBe(
    true,
  )
  await emitText({ threadID: id, runID: value.runID, messageID }, 2, {
    kind: 'run-completed',
    text: 'Hello world',
  })
  const resumed = await request(
    `/api/threads/${id}/runs/${value.runID}/events`,
    observe(id, value.runID),
    { ...Object.fromEntries(login.headers), 'Last-Event-ID': cursor },
  )
  const final = await resumed.text()
  expect(final).toContain('"delta":" world"')
  expect(final).not.toContain('"delta":"Hello world"')
  expect(final).toContain('TEXT_MESSAGE_START')
  const replay = await request(
    `/api/threads/${id}/runs/${value.runID}/events`,
    observe(id, value.runID),
  )
  expect((await replay.text()).startsWith(frames[0] ?? 'missing')).toBe(true)
  await assertCompletedSnapshot(id, messageID)
})

test('process shutdown closes an owned stream without cancelling its durable run', async () => {
  const id = await thread()
  const { value } = await submit(id)
  const signal = new AbortController()
  const local = createHTTP(db, {
    authentication: login.authentication,
    signal: signal.signal,
    pollIntervalMs: 5,
  })
  const response = await local(
    new Request(`http://local/api/threads/${id}/runs/${value.runID}/events`, {
      method: 'POST',
      headers: login.headers,
      body: JSON.stringify(observe(id, value.runID)),
    }),
  )
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing stream')
  await reader.read()
  const pending = reader.read()
  signal.abort()
  expect((await pending).done).toBe(true)
  expect(
    await db
      .selectFrom('product.command_outbox')
      .selectAll()
      .where('thread_id', '=', id)
      .execute(),
  ).toHaveLength(1)
})

test('request abort closes a pending subscription without cancelling its run', async () => {
  const id = await thread()
  const { value } = await submit(id)
  const abort = new AbortController()
  const response = await handle(
    new Request(`http://local/api/threads/${id}/runs/${value.runID}/events`, {
      method: 'POST',
      headers: login.headers,
      body: JSON.stringify(observe(id, value.runID)),
      signal: abort.signal,
    }),
  )
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing stream')
  await reader.read()
  const pending = reader.read()
  abort.abort()
  expect((await pending).done).toBe(true)
  expect(
    await db
      .selectFrom('product.command_outbox')
      .selectAll()
      .where('thread_id', '=', id)
      .execute(),
  ).toHaveLength(1)
})

test('real Bun HTTP reconnect reconstructs durable text with a fresh handler', async () => {
  const id = await thread()
  const { value } = await submit(id)
  const messageID = crypto.randomUUID()
  await emitText({ threadID: id, runID: value.runID, messageID }, 1, {
    kind: 'assistant-text',
    delta: 'Hello',
  })
  const first = await request(
    `/api/threads/${id}/runs/${value.runID}/events`,
    observe(id, value.runID),
  )
  const chunk = await readFirstFact(first)
  const cursor = chunk
    .split('\n')
    .find((line) => line.startsWith('id: '))
    ?.slice(4)
  if (!cursor) throw new Error('Missing cursor')
  await emitText({ threadID: id, runID: value.runID, messageID }, 2, {
    kind: 'run-completed',
    text: 'Hello world',
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: createHTTP(db, {
      authentication: login.authentication,
      signal: shutdown.signal,
      pollIntervalMs: 5,
    }),
  })
  try {
    const response = await fetch(
      new URL(`/api/threads/${id}/runs/${value.runID}/events`, server.url),
      {
        method: 'POST',
        headers: {
          ...Object.fromEntries(login.headers),
          'Last-Event-ID': cursor,
        },
        body: JSON.stringify(observe(id, value.runID)),
        signal: AbortSignal.timeout(3000),
      },
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"delta":" world"')
    expect(text).toContain('TEXT_MESSAGE_START')
    expect(text).toContain('RUN_STARTED')
    expect(text).toContain('RUN_FINISHED')
  } finally {
    await server.stop(true)
  }
})

async function waitForBlockedPublicRead(applicationName: string) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const blocked = await sql<{ count: number }>`
      select count(*)::int as count from pg_stat_activity
      where application_name = ${applicationName}
        and wait_event_type = 'Lock' and query like '%execution_events%'
    `.execute(db)
    if (blocked.rows[0]?.count) return
    await Bun.sleep(10)
  }
  throw new Error('Public event query did not block')
}

async function lockPublicFactLedger() {
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let locked!: () => void
  const acquired = new Promise<void>((resolve) => {
    locked = resolve
  })
  const done = db.transaction().execute(async (tx) => {
    await sql`lock table product.execution_events in access exclusive mode`.execute(
      tx,
    )
    locked()
    await released
  })
  await acquired
  return { release, done }
}

async function startIdentifiedServer(applicationName: string) {
  const env = serverTestEnv()
  const databaseURL = new URL(env.DATABASE_URL)
  databaseURL.searchParams.set('application_name', applicationName)
  return await startServer(
    {
      ...env,
      DATABASE_URL: databaseURL.toString(),
      IO_TIMEOUT_MS: 10000,
      POLL_MS: 10,
    },
    { port: 0 },
  )
}

test('server shutdown retains DB connections until a real in-flight SSE query settles', async () => {
  const id = await thread()
  const { value } = await submit(id)
  const applicationName = `sse-shutdown-${crypto.randomUUID()}`
  const process = await startIdentifiedServer(applicationName)
  const lock = await lockPublicFactLedger()
  const reading = fetch(
    `${process.url}/api/threads/${id}/runs/${value.runID}/events`,
    {
      method: 'POST',
      headers: login.headers,
      body: JSON.stringify(observe(id, value.runID)),
    },
  )
    .then((response) => response.text())
    .catch(() => '')
  try {
    await waitForBlockedPublicRead(applicationName)
    let stopped = false
    const stopping = process.stop().then(() => {
      stopped = true
    })
    await Bun.sleep(500)
    expect(stopped).toBe(false)
    // Closing pg.Pool early destroys idle connections while a checked-out query
    // is still live. Keeping them proves teardown has not entered DB close.
    const idle = await sql<{ count: number }>`
      select count(*)::int as count from pg_stat_activity
      where application_name = ${applicationName} and state = 'idle'
    `.execute(db)
    expect(idle.rows[0]?.count).toBeGreaterThan(0)
    lock.release()
    await lock.done
    await stopping
    await reading
    expect(
      await (await request(`/api/threads/${id}/messages`)).json(),
    ).toMatchObject({
      messages: [{ role: 'user', text: 'Hello' }],
    })
  } finally {
    lock.release()
    await lock.done
    await process.stop()
    await reading
  }
}, 15000)

test('non-prefix completion reconciles from the canonical message snapshot', async () => {
  const id = await thread()
  const { value } = await submit(id)
  const messageID = crypto.randomUUID()
  const identities = { threadID: id, runID: value.runID, messageID }
  await emitText(identities, 1, { kind: 'assistant-text', delta: 'Draft' })
  await emitText(identities, 2, {
    kind: 'run-completed',
    text: 'Canonical answer',
  })
  const response = await request(
    `/api/threads/${id}/runs/${value.runID}/events`,
    observe(id, value.runID),
  )
  const stream = await response.text()
  expect(stream).toContain('"delta":"Draft"')
  expect(stream).not.toContain('"delta":"Canonical answer"')
  expect(stream).toContain('RUN_FINISHED')
  expect(
    await (await request(`/api/threads/${id}/messages`)).json(),
  ).toMatchObject({
    messages: expect.arrayContaining([
      expect.objectContaining({
        messageID,
        role: 'assistant',
        text: 'Canonical answer',
      }),
    ]),
  })
})

test('official AG-UI HttpAgent accepts cursor reconnect lifecycle and final cursor metadata', async () => {
  const id = await thread()
  const { value } = await submit(id)
  const messageID = crypto.randomUUID()
  await emitText({ threadID: id, runID: value.runID, messageID }, 1, {
    kind: 'assistant-text',
    delta: 'Hello',
  })
  const facts = await readPublicEvents(db, {
    ownerID: login.user.id,
    threadID: id,
  })
  const cursor = facts?.at(-1)?.cursor
  if (!cursor) throw new Error('Missing text cursor')
  await emitText({ threadID: id, runID: value.runID, messageID }, 2, {
    kind: 'run-completed',
    text: 'Hello world',
  })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handle })
  try {
    const events: ReturnType<typeof EventSchema.parse>[] = []
    const agent = new HttpAgent({
      url: new URL(
        `/api/threads/${id}/runs/${value.runID}/events`,
        server.url,
      ).toString(),
      threadId: id,
      headers: {
        Cookie: login.headers.get('cookie')!,
        Origin: login.headers.get('origin')!,
      },
    })
    await agent.runAgent(
      { runId: value.runID, forwardedProps: { after: cursor } },
      {
        onEvent({ event }) {
          events.push(EventSchema.parse(event))
        },
      },
    )
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    expect(events.at(-1)?.metadata?.cursor).toMatch(/^[1-9][0-9]*$/)
    expect(agent.messages).toMatchObject([
      { id: messageID, role: 'assistant', content: ' world' },
    ])
  } finally {
    await server.stop(true)
  }
})

function lastFactCursor(text: string) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('id: '))
    .at(-1)
    ?.slice(4)
}

test('observation rejects a fabricated future cursor', async () => {
  const id = await thread()
  const { value } = await submit(id)
  await emitText(
    { threadID: id, runID: value.runID, messageID: crypto.randomUUID() },
    1,
    { kind: 'run-completed', text: 'done' },
  )
  const facts = await readPublicEvents(db, {
    ownerID: login.user.id,
    threadID: id,
  })
  const cursor = facts?.at(-1)?.cursor
  if (!cursor) throw new Error('Missing terminal cursor')
  const response = await request(
    `/api/threads/${id}/runs/${value.runID}/events`,
    {
      ...observe(id, value.runID),
      forwardedProps: { after: String(BigInt(cursor) + 100n) },
    },
  )
  expect(response.status).toBe(400)
})

test('Last-Event-ID takes precedence over an invalid forwarded cursor on reconnect', async () => {
  const id = await thread()
  const { value } = await submit(id)
  await emitText(
    { threadID: id, runID: value.runID, messageID: crypto.randomUUID() },
    1,
    { kind: 'run-completed', text: 'done' },
  )
  const facts = await readPublicEvents(db, {
    ownerID: login.user.id,
    threadID: id,
  })
  const cursor = facts?.at(-1)?.cursor
  if (!cursor) throw new Error('Missing terminal cursor')
  const response = await request(
    `/api/threads/${id}/runs/${value.runID}/events`,
    { ...observe(id, value.runID), forwardedProps: { after: 'not-a-cursor' } },
    { 'Last-Event-ID': cursor },
  )
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('RUN_STARTED')
})

test.each(['not-a-cursor', '01', '-1', '9223372036854775808'])(
  'invalid reconnect cursor %s returns input rejection instead of a process failure',
  async (cursor) => {
    const id = await thread()
    const { value } = await submit(id)
    const response = await request(
      `/api/threads/${id}/runs/${value.runID}/events`,
      observe(id, value.runID),
      { 'Last-Event-ID': cursor },
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid input' })
  },
)

test('official generated fetch client creates, replays, reads, submits and durably logs out through native routes', async () => {
  const identity = await signedTestIdentity(db)
  const local = createHTTP(db, {
    authentication: identity.authentication,
    signal: shutdown.signal,
    pollIntervalMs: 5,
  })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: local })
  const client = createClient({
    baseUrl: server.url.toString(),
    headers: identity.headers,
  })
  const threadID = crypto.randomUUID()
  threads.push(threadID)
  try {
    const body = { threadID, title: ' Generated client ' }
    const created = await createThread({ client, body, throwOnError: true })
    expect(created.response.status).toBe(201)
    expect(created.data.thread.title).toBe('Generated client')
    expect(
      (await createThread({ client, body, throwOnError: true })).response
        .status,
    ).toBe(200)
    const read = await getThread({
      client,
      path: { threadID },
      throwOnError: true,
    })
    expect(read.response.status).toBe(200)
    expect(read.data.thread.threadID).toBe(threadID)
    const submitted = await submitMessage({
      client,
      throwOnError: true,
      path: { threadID },
      body: { messageID: crypto.randomUUID(), text: 'hello' },
    })
    expect(submitted.response.status).toBe(202)
    expect(submitted.data.runID).toBeDefined()
    const signedOut = await logout({ client, body: {}, throwOnError: true })
    expect(signedOut.response.status).toBe(200)
    expect(signedOut.response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(
      (await getThread({ client, path: { threadID } })).response?.status,
    ).toBe(401)
  } finally {
    await server.stop(true)
  }
})

test('server shutdown cancels a slow S3 response body before closing its owned client and DB', async () => {
  const id = await thread()
  const assetID = crypto.randomUUID()
  const bytes = new TextEncoder().encode('slow')
  await db
    .insertInto('product.assets')
    .values({
      asset_id: assetID,
      thread_id: id,
      source: 'upload',
      name: 'slow.txt',
      mime_type: 'text/plain',
      byte_length: bytes.length,
      sha256: sha256(bytes),
      object_key: `assets/uploads/${id}/${assetID}`,
      ready_at: new Date(),
    })
    .execute()
  let began!: () => void
  let release!: () => void
  const streaming = new Promise<void>((resolve) => {
    began = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const storage = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(bytes.slice(0, 1))
            began()
            await released
            controller.enqueue(bytes.slice(1))
            controller.close()
          },
        }),
        {
          headers: {
            'content-type': 'text/plain',
            'content-length': String(bytes.length),
          },
        },
      ),
  })
  const process = await startServer(
    {
      ...serverTestEnv(),
      OBJECT_STORAGE_URL: storage.url.toString(),
      FILE_IO_TIMEOUT_MS: 5000,
    },
    { port: 0 },
  )
  const reading = fetch(`${process.url}/api/assets/${assetID}/file`, {
    headers: login.headers,
  })
    .then((response) => response.text())
    .catch(() => '')
  let stopping: Promise<void> | undefined
  try {
    await streaming
    // Let the SDK receive headers and enter the bounded body read.
    await Bun.sleep(100)
    let stopped = false
    stopping = process.stop().then(() => {
      stopped = true
    })
    await Bun.sleep(250)
    expect(stopped).toBe(true)
  } finally {
    release()
    await stopping
    await process.stop()
    await reading
    await storage.stop(true)
  }
}, 10000)

test.each([
  'execution-error',
  'interrupted',
  'sandbox-recovery-required',
] as const)(
  'fresh message snapshots retain durable %s failures without SSE or assistant messages',
  async (reason) => {
    const id = await thread()
    const { body, value } = await submit(id)
    // A terminal is canonical on receipt even while replay awaits an ordinal gap.
    const delivery = {
      ordinal: 2,
      event: {
        version: 1,
        eventID: crypto.randomUUID(),
        threadID: id,
        runID: value.runID,
        kind: 'run-failed',
        reason,
      },
    } as const
    expect(await acceptExecutionEvent(db, delivery)).toBe('accepted')
    expect(await acceptExecutionEvent(db, delivery)).toBe('accepted')
    const fresh = createHTTP(db, {
      authentication: login.authentication,
      signal: shutdown.signal,
      pollIntervalMs: 5,
    })
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: fresh })
    const client = createClient({
      baseUrl: server.url.toString(),
      headers: login.headers,
    })
    try {
      for (let reload = 0; reload < 2; reload++) {
        const snapshot = await listMessages({
          client,
          path: { threadID: id },
          throwOnError: true,
        })
        expect(messagesResponseSchema.parse(snapshot.data)).toEqual({
          messages: [
            {
              messageID: body.messageID,
              role: 'user',
              text: 'Hello',
              createdAt: expect.any(String),
              assets: [],
            },
          ],
          activeRuns: [],
          failedRuns: [
            { runID: value.runID, messageID: body.messageID, reason },
          ],
        })
      }
    } finally {
      await server.stop(true)
    }
    const foreign = createHTTP(db, {
      authentication: other.authentication,
      signal: shutdown.signal,
      pollIntervalMs: 10,
    })
    expect(
      (
        await foreign(
          new Request(`http://local/api/threads/${id}/messages`, {
            headers: other.headers,
          }),
        )
      ).status,
    ).toBe(404)
  },
)

test('snapshot retains failure authorized by legacy uppercase JSON headers', async () => {
  const id = await thread()
  const { body, value } = await submit(id)
  expect(
    await acceptExecutionEvent(db, {
      ordinal: 2,
      event: {
        version: 1,
        kind: 'run-failed',
        eventID: crypto.randomUUID(),
        threadID: id,
        runID: value.runID,
        reason: 'execution-error',
      },
    }),
  ).toBe('accepted')
  await sql`update product.command_outbox set command =
    jsonb_set(jsonb_set(jsonb_set(jsonb_set(command,
      '{threadID}', to_jsonb(upper(thread_id::text))),
      '{runID}', to_jsonb(upper(run_id::text))),
      '{commandID}', to_jsonb(upper(command_id::text))),
      '{input,messageID}', to_jsonb(upper(message_id::text)))
    where thread_id = ${id}::uuid`.execute(db)
  expect(
    await (await request(`/api/threads/${id}/messages`)).json(),
  ).toMatchObject({
    activeRuns: [],
    failedRuns: [
      {
        runID: value.runID,
        messageID: body.messageID,
        reason: 'execution-error',
      },
    ],
  })
})

test.each(['{threadID}', '{runID}', '{commandID}', '{input,messageID}'])(
  'legacy header %s still requires exact SQL UUID authority without malformed casts',
  async (path) => {
    const id = await thread()
    const { value } = await submit(id)
    const delivery = {
      ordinal: 2,
      event: {
        version: 1,
        kind: 'run-failed',
        eventID: crypto.randomUUID(),
        threadID: id,
        runID: value.runID,
        reason: 'execution-error',
      },
    } as const
    expect(await acceptExecutionEvent(db, delivery)).toBe('accepted')
    for (const invalid of ['not-a-uuid', crypto.randomUUID().toUpperCase()]) {
      await sql`update product.command_outbox set command =
        jsonb_set(command, ${path}::text[], to_jsonb(${invalid}::text))
        where thread_id = ${id}::uuid`.execute(db)
      expect(await acceptExecutionEvent(db, delivery)).toBe('unknown-run')
      expect(
        await (await request(`/api/threads/${id}/messages`)).json(),
      ).toMatchObject({
        failedRuns: [],
      })
    }
  },
)
