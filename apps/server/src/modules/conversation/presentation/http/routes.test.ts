import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createTestDatabase } from '../../../../../../../tests/fixtures/database'
import { createPostgresConversations } from '../../infrastructure/persistence/conversations'
import { createConversation } from '../../application/conversation'
import { createRoutes } from './routes'

let database: Awaited<ReturnType<typeof createTestDatabase>>

beforeAll(async () => {
  database = await createTestDatabase()
})

afterAll(async () => {
  await database.close()
})

const fixture = async () => {
  const store = createPostgresConversations(database.product)
  const conversation = createConversation(store)
  const threadID = await conversation.open({ userID: 'owner' })

  const api = createRoutes({
    store,
    conversation,
    sign: async (key) => key,
    readerOf: async (request) => {
      const userID = request.headers.get('x-user')
      return userID === null ? null : { userID }
    },
  })

  const request = (path: string, init: RequestInit = {}) =>
    api.request(`/threads/${threadID}${path}`, {
      ...init,
      headers: new Headers({ 'x-user': 'owner', ...Object.fromEntries(new Headers(init.headers)) }),
    })

  return { api, store, threadID, request }
}

test.each([
  { method: 'POST', path: '/threads' },
  { method: 'POST', path: '/threads/:thread/messages' },
  { method: 'POST', path: '/threads/:thread/stop' },
  { method: 'GET', path: '/threads/:thread/events' },
])('$method $path requires sign-in before reading input or conversation state', async (route) => {
  const { api, threadID, store } = await fixture()

  const response = await api.request(route.path.replace(':thread', threadID), {
    method: route.method,
    headers: { 'last-event-id': 'invalid' },
  })

  expect(response.status).toBe(401)
  expect(await response.text()).toBe('sign in')
  expect((await store.snapshot(threadID)).messages).toEqual([])
})

test('unregistered routes remain not found without sign-in', async () => {
  const { api } = await fixture()

  const response = await api.request('/threads/unknown/unsupported')

  expect(response.status).toBe(404)
})

test('opening a conversation persists its authenticated owner before replying', async () => {
  const { api, store } = await fixture()

  const response = await api.request('/threads', {
    method: 'POST',
    headers: { 'x-user': 'creator' },
  })
  const { threadID } = (await response.json()) as { threadID: string }

  expect(response.status).toBe(201)
  expect(await store.thread(threadID)).toEqual({ threadID, userID: 'creator', activeTurnID: null })
})

test('acceptance commits the message and command before replying, with exact replay', async () => {
  const { store, threadID, request } = await fixture()
  const commandID = crypto.randomUUID()
  const input = { method: 'POST', body: JSON.stringify({ commandID, message: 'Make a video' }) }

  const accepted = await request('/messages', input)
  const replayed = await request('/messages', input)

  expect(accepted.status).toBe(202)
  expect(await accepted.json()).toEqual({ commandID })
  expect(replayed.status).toBe(202)
  expect(await replayed.json()).toEqual({ commandID })
  expect((await store.snapshot(threadID)).messages).toHaveLength(1)
  const commands =
    await database.product`select body from product.outbox where command_id = ${commandID}`
  expect(commands).toHaveLength(1)
  expect(commands[0].body.message).toBe('Make a video')
})

test.each(['{}', 'invalid json', '{"message":"  "}'])(
  'malformed input %s cannot enqueue work',
  async (body) => {
    const { request, threadID, store } = await fixture()

    const response = await request('/messages', { method: 'POST', body })

    expect(response.status).toBe(400)
    expect(await response.text()).toBe('a message is required')
    expect((await store.snapshot(threadID)).messages).toEqual([])
  },
)

test.each([
  { method: 'POST', path: '/messages' },
  { method: 'POST', path: '/stop' },
  { method: 'GET', path: '/events' },
])('$method $path hides inaccessible and missing conversations', async (route) => {
  const { api, request, threadID, store } = await fixture()
  const init = {
    method: route.method,
    headers: { 'x-user': 'stranger', 'last-event-id': 'invalid' },
    ...(route.path === '/messages' ? { body: '{"message":"hello"}' } : {}),
  }

  const privateThread = await request(route.path, init)
  const missingThread = await api.request(`/threads/${crypto.randomUUID()}${route.path}`, init)

  expect(privateThread.status).toBe(404)
  expect(missingThread.status).toBe(404)
  expect(await privateThread.text()).toBe('no such conversation')
  expect(await missingThread.text()).toBe('no such conversation')
  expect((await store.snapshot(threadID)).messages).toEqual([])
})

test('a message without a command ID receives its durable ID and trims whitespace', async () => {
  const { request, threadID, store } = await fixture()

  const response = await request('/messages', { method: 'POST', body: '{"message":" hello "}' })
  const { commandID } = (await response.json()) as { commandID: string }

  expect(response.status).toBe(202)
  expect((await store.snapshot(threadID)).messages).toMatchObject([
    { id: `${commandID}:asked`, text: 'hello' },
  ])
})

test('stopping an idle conversation succeeds without creating a command', async () => {
  const { request, threadID } = await fixture()

  const response = await request('/stop', { method: 'POST' })
  const commands = await database.product`
    select body from product.outbox
    where body->>'threadID' = ${threadID}
  `

  expect(response.status).toBe(202)
  expect(await response.text()).toBe('')
  expect(commands).toEqual([])
})

test('stopping an active conversation commits a command targeting its current turn', async () => {
  const { request, threadID } = await fixture()
  const turnID = crypto.randomUUID()
  await database.product`
    update product.threads
    set active_turn_id = ${turnID}
    where thread_id = ${threadID}
  `

  const response = await request('/stop', { method: 'POST' })
  const commands = await database.product`
    select body from product.outbox
    where body->>'threadID' = ${threadID}
  `

  expect(response.status).toBe(202)
  expect(commands).toHaveLength(1)
  expect(commands[0].body).toMatchObject({ kind: 'stop', threadID, turnID })
})

test('an accessible event stream rejects malformed cursors', async () => {
  const { request } = await fixture()

  const response = await request('/events', { headers: { 'last-event-id': 'invalid' } })

  expect(response.status).toBe(400)
  expect(await response.text()).toBe('invalid event cursor')
})

test('SSE resumes after a committed cursor without duplicating its snapshot', async () => {
  const { request, store, threadID } = await fixture()
  await store.accept({ threadID, commandID: crypto.randomUUID(), message: 'First' })

  const initial = await request('/events')
  const first = initial.body!.getReader()
  const snapshot = new TextDecoder().decode((await first.read()).value)
  expect(snapshot).toContain('MESSAGES_SNAPSHOT')
  expect(snapshot).toContain('id: 1')
  await first.cancel()

  await store.accept({ threadID, commandID: crypto.randomUUID(), message: 'Second' })
  const resumed = await request('/events', { headers: { 'last-event-id': '1' } })
  const reader = resumed.body!.getReader()
  const frames = new TextDecoder().decode((await reader.read()).value)

  expect(frames).toContain('Second')
  expect(frames).not.toContain('First')
  expect(frames).not.toContain('MESSAGES_SNAPSHOT')
  expect(frames).toContain('id: 2')
  await reader.cancel()
})

test('a conflicting command ID returns 409 without changing the accepted message', async () => {
  const { request, store, threadID } = await fixture()
  const commandID = crypto.randomUUID()
  await request('/messages', {
    method: 'POST',
    body: JSON.stringify({ commandID, message: 'First' }),
  })

  const response = await request('/messages', {
    method: 'POST',
    body: JSON.stringify({ commandID, message: 'Changed' }),
  })

  expect(response.status).toBe(409)
  expect(await response.text()).toBe('command ID was already used for different input')
  expect((await store.snapshot(threadID)).messages).toMatchObject([{ text: 'First' }])
})

test('request cancellation closes SSE and stops polling', async () => {
  const { request } = await fixture()
  const stopped = new AbortController()

  const response = await request('/events', { signal: stopped.signal })
  const reader = response.body!.getReader()
  await reader.read()

  stopped.abort()
  expect((await reader.read()).done).toBe(true)
})

test('an aborted SSE request still closes when its pending query fails', async () => {
  const { request, store } = await fixture()
  const polling = Promise.withResolvers<void>()
  const query = Promise.withResolvers<Awaited<ReturnType<typeof store.changes>>>()
  store.changes = async () => {
    polling.resolve()
    return query.promise
  }

  const stopped = new AbortController()
  const response = await request('/events', { signal: stopped.signal })
  const reader = response.body!.getReader()
  await reader.read()
  await polling.promise

  stopped.abort()
  query.reject(new Error('query cancelled'))
  expect((await reader.read()).done).toBe(true)
})
