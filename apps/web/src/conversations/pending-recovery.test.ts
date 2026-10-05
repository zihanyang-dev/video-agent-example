import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import {
  MutationObserver,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { ChatCreation } from './chat-creation'
import { useMessageSubmission } from './use-message-submission'
import { requestRunCancellation } from './run-panel'
import { pendingIntentRecoveryMessage } from './pending-intents'
import { HTTPError } from '../http'

function MessageRecovery() {
  const state = useMessageSubmission({ userID: 'alice', threadID: 'chat' })
  return createElement('p', { 'data-blocked': state.hasPending }, state.error)
}

for (const Component of [ChatCreation, MessageRecovery]) {
  test(`${Component.name} remains readable and blocks replacement after retained intent corruption`, () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'localStorage',
    )
    const storage: Storage = {
      length: 1,
      key: () => 'retained-corrupt-intent',
      getItem: () => 'private_pending_request_not_json',
      setItem: () => {
        throw new Error('Must not replace a retained request')
      },
      removeItem: () => {
        throw new Error('Must not discard an unknown receipt')
      },
      clear: () => {
        throw new Error('Must not clear another account')
      },
    }
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    })
    const client = new QueryClient()
    try {
      const html = renderToString(
        createElement(QueryClientProvider, {
          client,
          children: createElement(Component, {
            userID: 'alice',
            create: async () => {
              throw new Error('Must not create a replacement Chat')
            },
          }),
        }),
      )
      expect(html).toContain('Check Chat history before clearing browser data.')
      expect(html).not.toContain('private_pending_request_not_json')
      expect(html).toMatch(/disabled=|data-blocked="true"/)
    } finally {
      client.clear()
      if (descriptor)
        Object.defineProperty(globalThis, 'localStorage', descriptor)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })
}

test('corrupt cancellation retains bytes and exposes owned history recovery without sending HTTP or allocating a replacement', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalFetch = globalThis.fetch
  const uuidDescriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID')
  const originalUUID = crypto.randomUUID.bind(crypto)
  let requests = 0
  let allocated = 0
  let retained = 'private_pending_request_not_json'
  const storage: Storage = {
    length: 1,
    key: () => 'frame:intent:alice:cancel:chat:run',
    getItem: () => retained,
    setItem: (_key, bytes) => {
      retained = bytes
    },
    removeItem: () => {
      retained = ''
    },
    clear: () => {
      retained = ''
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
  globalThis.fetch = Object.assign(
    async () => {
      requests++
      return Response.json({})
    },
    { preconnect: originalFetch.preconnect },
  )
  crypto.randomUUID = () => {
    allocated++
    return originalUUID.call(crypto)
  }
  const client = new QueryClient()
  try {
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () =>
        requestRunCancellation({ userID: 'alice', threadID: 'chat' }, 'run'),
    })
    const receipt = await mutation.execute(undefined)
    expect(receipt.storageError).toBe(pendingIntentRecoveryMessage)
    expect(receipt.storageError).not.toContain('private_pending')
    expect(retained).toBe('private_pending_request_not_json')
    expect(requests).toBe(0)
    expect(allocated).toBe(0)
  } finally {
    client.clear()
    globalThis.fetch = originalFetch
    if (uuidDescriptor)
      Object.defineProperty(crypto, 'randomUUID', uuidDescriptor)
    else Reflect.deleteProperty(crypto, 'randomUUID')
    if (descriptor)
      Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('unknown cancellation receipt retries the same frozen ID through the official SDK', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalFetch = globalThis.fetch
  const saved = new Map<string, string>()
  const bodies: unknown[] = []
  const storage: Storage = {
    length: 0,
    key: () => null,
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, bytes) => {
      saved.set(key, bytes)
    },
    removeItem: (key) => {
      saved.delete(key)
    },
    clear: () => saved.clear(),
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      bodies.push(await request.json())
      if (bodies.length === 1) throw new Error('private lost receipt')
      return Response.json({})
    },
    { preconnect: originalFetch.preconnect },
  )
  const client = new QueryClient()
  try {
    const options = {
      mutationFn: () =>
        requestRunCancellation(
          { userID: 'alice', threadID: '11111111-1111-4111-8111-111111111111' },
          '22222222-2222-4222-8222-222222222222',
        ),
    }
    let failure: unknown
    try {
      await client.getMutationCache().build(client, options).execute(undefined)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(HTTPError)
    expect(String(failure)).not.toContain('private')
    const bytes = [...saved.values()][0]
    expect(bytes).toBeDefined()
    expect(
      await client.getMutationCache().build(client, options).execute(undefined),
    ).toEqual({ storageError: '' })
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual(bodies[0])
    expect([...saved.values()][0]).toBe(bytes)
  } finally {
    client.clear()
    globalThis.fetch = originalFetch
    if (descriptor)
      Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('native creation success callback contains removeItem failure after generated HTTP acceptance', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalFetch = globalThis.fetch
  const saved = new Map<string, string>()
  const storage: Storage = {
    length: 0,
    key: () => null,
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => {
      saved.set(key, value)
    },
    removeItem: () => {
      throw new Error('private cleanup diagnostic')
    },
    clear: () => {},
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
  globalThis.fetch = Object.assign(async () => Response.json({}), {
    preconnect: originalFetch.preconnect,
  })
  const client = new QueryClient()
  const { acceptChatCreation } = await import('./chat-creation')
  const { pendingIntents } = await import('./pending-intents')
  const { createThread } = await import('@vid/contract/client')
  const { apiForUser } = await import('../http')
  const intents = pendingIntents('alice')
  const intent = intents.creation('Accepted Chat')
  const before = [...saved.values()]
  let recovery = ''
  const observer = new MutationObserver(client, {
    mutationFn: async () => {
      await createThread({
        client: apiForUser('alice'),
        body: intent,
        throwOnError: true,
      })
    },
  })
  const unsubscribe = observer.subscribe(() => {})
  try {
    await observer.mutate(undefined, {
      onSuccess: () => {
        recovery = acceptChatCreation(intents)
      },
    })
    expect(observer.getCurrentResult().isSuccess).toBe(true)
    expect(recovery).toBe(
      'Chat accepted, saved request could not be removed. Check Chat history before retrying.',
    )
    expect(recovery).not.toContain('private')
    expect([...saved.values()]).toEqual(before)
  } finally {
    unsubscribe()
    client.clear()
    globalThis.fetch = originalFetch
    if (descriptor)
      Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
