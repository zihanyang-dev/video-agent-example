import { expect, test } from 'bun:test'
import { createThread } from '@vid/contract/client'
import { abortHTTP, apiForUser, HTTPError, retryRead } from './http'

for (const status of [401, 403, 404]) {
  test(`authority refusal ${status} is not automatically retried`, () => {
    expect(retryRead(0, new HTTPError(status))).toBe(false)
  })
}

test('JSON mutations use the same-origin cookie boundary and suppress private response diagnostics', async () => {
  const original = globalThis.fetch
  let captured: RequestInit | undefined
  globalThis.fetch = Object.assign(
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured =
        _url instanceof Request ? { ...init, headers: _url.headers } : init
      return Response.json(
        { error: 'private database secret' },
        { status: 403 },
      )
    },
    { preconnect: original.preconnect },
  )
  try {
    let failure: unknown
    try {
      await createThread({
        client: apiForUser('alice'),
        body: { threadID: crypto.randomUUID(), title: 'Chat' },
        throwOnError: true,
      })
    } catch (error) {
      failure = error
    }
    expect(captured?.credentials).toBe('same-origin')
    expect(new Headers(captured?.headers).get('Content-Type')).toBe(
      'application/json',
    )
    expect(failure).toBeInstanceOf(HTTPError)
    expect(String(failure)).not.toContain('secret')
  } finally {
    globalThis.fetch = original
  }
})

test('settling an aborted request cannot detach the next request from account shutdown', async () => {
  const previous = globalThis.fetch
  const firstStarted = Promise.withResolvers<AbortSignal>()
  const secondStarted = Promise.withResolvers<AbortSignal>()
  const firstReceipt = Promise.withResolvers<Response>()
  const secondReceipt = Promise.withResolvers<Response>()
  let dispatches = 0
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const isFirst = dispatches++ === 0
      const started = isFirst ? firstStarted : secondStarted
      started.resolve(request.signal)
      return (isFirst ? firstReceipt : secondReceipt).promise
    },
    { preconnect: previous.preconnect },
  )
  const userID = 'abort-ownership-test'
  const dispatch = (threadID: string) =>
    createThread({
      client: apiForUser(userID),
      body: { threadID, title: 'Chat' },
      throwOnError: true,
    }).then(
      () => null,
      (error: unknown) => error,
    )
  try {
    const first = dispatch('11111111-1111-4111-8111-111111111111')
    const firstSignal = await firstStarted.promise
    abortHTTP(userID)
    expect(firstSignal.aborted).toBe(true)

    const second = dispatch('22222222-2222-4222-8222-222222222222')
    const secondSignal = await secondStarted.promise
    expect(secondSignal.aborted).toBe(false)
    firstReceipt.reject(new Error('Delayed abort settlement'))
    expect(await first).toBeInstanceOf(HTTPError)

    abortHTTP(userID)
    const wasAborted = secondSignal.aborted
    secondReceipt.reject(new Error('Controlled request settlement'))
    expect(await second).toBeInstanceOf(HTTPError)
    expect(wasAborted).toBe(true)
  } finally {
    firstReceipt.reject(new Error('Test cleanup'))
    secondReceipt.reject(new Error('Test cleanup'))
    abortHTTP(userID)
    globalThis.fetch = previous
  }
})
