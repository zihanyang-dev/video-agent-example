import { createThread } from '@vid/contract/client'
import { expect, test } from 'bun:test'
import { HTTPError, apiForUser, retryRead } from './http'

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
