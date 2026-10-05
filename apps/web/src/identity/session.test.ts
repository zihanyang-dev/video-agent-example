import { expect, test } from 'bun:test'
import { QueryObserver } from '@tanstack/react-query'

import {
  publishRevokedSession,
  forgetAccountFacts,
  revokeAccountSession,
} from './session-cache'

import { createWebQueryClient, sessionQuery } from './session'
import { HTTPError, apiForUser, abortHTTP } from '../http'
import { createThread } from '@vid/contract/client'

test('a session refusal discards all cached private facts rather than leaving stale Chats readable', async () => {
  const client = createWebQueryClient()
  client.setQueryData(sessionQuery.queryKey, {
    user: {
      userID: 'alice',
      name: 'Alice',
      email: 'alice@example.com',
      image: null,
    },
  })
  client.setQueryData(['user', 'alice', 'threads'], { threads: ['private'] })
  try {
    await client.fetchQuery({
      queryKey: ['user', 'alice', 'unavailable'],
      queryFn: () => {
        throw new HTTPError(401)
      },
    })
  } catch {
    // The failed read is expected; its privacy side effect is the assertion.
  }
  expect(client.getQueryData(sessionQuery.queryKey)?.user).toBeNull()
  expect(client.getQueryData(['user', 'alice', 'threads'])).toBeUndefined()
  client.clear()
})

test('a late refusal from the previous account does not revoke the current browser identity', async () => {
  const client = createWebQueryClient()
  client.setQueryData(sessionQuery.queryKey, {
    user: { userID: 'bob', name: 'Bob', email: 'bob@example.com', image: null },
  })
  try {
    await client.fetchQuery({
      queryKey: ['user', 'alice', 'late'],
      queryFn: () => {
        throw new HTTPError(401)
      },
    })
  } catch {
    // The old read failed; the current account must remain usable.
  }
  expect(client.getQueryData(sessionQuery.queryKey)?.user?.userID).toBe('bob')
  client.clear()
})

test('repeated refusal removes non-session facts while preserving the mounted identity observer', async () => {
  const client = createWebQueryClient()
  client.setQueryData(sessionQuery.queryKey, { user: null })
  const observer = new QueryObserver(client, {
    ...sessionQuery,
    enabled: false,
  })
  const observed: unknown[] = []
  const unsubscribe = observer.subscribe((receipt) =>
    observed.push(receipt.data),
  )
  client.setQueryData(['private-preview'], { secret: 'private' })
  try {
    await client.fetchQuery({
      queryKey: ['session'],
      queryFn: () => {
        throw new HTTPError(401)
      },
      retry: false,
    })
  } catch {
    // A refusal must forget facts even when identity was already anonymous.
  }
  expect(client.getQueryData(['private-preview'])).toBeUndefined()
  client.setQueryData(sessionQuery.queryKey, { user: null })
  expect(observer.getCurrentResult().data?.user).toBeNull()
  expect(observed.length).toBeGreaterThan(0)
  unsubscribe()
  client.clear()
})

test('revocation keeps identity observers attached and leaves account-scoped unknown intents durable', () => {
  const client = createWebQueryClient()
  client.setQueryData(sessionQuery.queryKey, {
    user: {
      userID: 'alice',
      name: 'Alice',
      email: 'alice@example.com',
      image: null,
    },
  })
  const observer = new QueryObserver(client, {
    ...sessionQuery,
    enabled: false,
  })
  const unsubscribe = observer.subscribe(() => {})
  client.setQueryData(['user', 'alice', 'threads'], { threads: ['private'] })
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const retained = '{"messageID":"unknown"}'
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => retained,
      removeItem: () => {
        throw new Error('Unknown receipts must remain durable')
      },
      clear: () => {
        throw new Error('Unknown receipts must remain durable')
      },
    },
  })
  try {
    publishRevokedSession(client, 'alice')
    expect(observer.getCurrentResult().data?.user).toBeNull()
    expect(client.getQueryData(['user', 'alice', 'threads'])).toBeUndefined()
    expect(
      globalThis.localStorage.getItem('frame:intent:alice:message:chat'),
    ).toBe(retained)
    client.setQueryData(sessionQuery.queryKey, {
      user: {
        userID: 'bob',
        name: 'Bob',
        email: 'bob@example.com',
        image: null,
      },
    })
    publishRevokedSession(client, 'alice')
    expect(observer.getCurrentResult().data?.user?.userID).toBe('bob')
  } finally {
    unsubscribe()
    client.clear()
    if (descriptor)
      Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('forgetting anonymous account facts aborts an orphaned account mutation without publishing a new identity', async () => {
  const client = createWebQueryClient()
  client.setQueryData(sessionQuery.queryKey, { user: null })
  const originalFetch = globalThis.fetch
  let requestSignal: AbortSignal | undefined
  let signalDispatch: (() => void) | undefined
  const dispatched = new Promise<void>((resolve) => {
    signalDispatch = resolve
  })
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requestSignal = request.signal
      signalDispatch?.()
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        )
      })
    },
    { preconnect: originalFetch.preconnect },
  )
  let completed: Promise<unknown> | undefined
  try {
    const mutation = client.getMutationCache().build(client, {
      meta: { userID: 'alice' },
      mutationFn: () =>
        createThread({
          client: apiForUser('alice'),
          body: { threadID: crypto.randomUUID(), title: 'Chat' },
          throwOnError: true,
        }),
    })
    completed = mutation.execute(undefined).catch((failure: unknown) => failure)
    await dispatched
    forgetAccountFacts(client)
    expect(requestSignal?.aborted).toBe(true)
    expect(client.getQueryData(sessionQuery.queryKey)?.user).toBeNull()
  } finally {
    abortHTTP('alice')
    await completed
    globalThis.fetch = originalFetch
    client.clear()
  }
})

test('unconfirmed public logout leaves the current identity and private facts intact', async () => {
  const client = createWebQueryClient()
  client.setQueryData(sessionQuery.queryKey, {
    user: {
      userID: 'alice',
      name: 'Alice',
      email: 'alice@example.com',
      image: null,
    },
  })
  client.setQueryData(['user', 'alice', 'threads'], { threads: ['private'] })
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({ error: 'private server diagnostic' }, { status: 503 }),
    { preconnect: originalFetch.preconnect },
  )
  try {
    let failure: unknown
    const mutation = client.getMutationCache().build(client, {
      meta: { userID: 'alice' },
      mutationFn: () => revokeAccountSession(client, 'alice'),
    })
    try {
      await mutation.execute(undefined)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(HTTPError)
    expect(String(failure)).not.toContain('private server diagnostic')
    expect(client.getQueryData(sessionQuery.queryKey)?.user?.userID).toBe(
      'alice',
    )
    expect(
      client.getQueryData<{ threads: string[] }>(['user', 'alice', 'threads']),
    ).toEqual({
      threads: ['private'],
    })
  } finally {
    globalThis.fetch = originalFetch
    client.clear()
  }
})
