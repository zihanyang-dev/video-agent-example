import { expect, test } from 'bun:test'
import { openE2BSandbox } from './e2b'

for (const scenario of ['idle', 'unknown', 'cancel', 'close-inflight'] as const) {
  test(`owned session lifetime: ${scenario}`, async () => {
    const paths: string[] = []
    const entered = Promise.withResolvers<void>()
    const receipt = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<void>()
    let failures = 0
    let expiry = Date.now() + 1000
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        paths.push(path)
        if (path === '/v2/sandboxes')
          return Response.json({
            sandboxID: 'owned-idle',
            envdVersion: '0.6.2',
            envdAccessToken: 'fixture',
          })
        if (path.endsWith('/timeout')) {
          expect(await request.json()).toEqual({ timeout: 1 })
          entered.resolve()
          if (scenario === 'cancel' || scenario === 'close-inflight') await receipt.promise
          expiry = Date.now() + 1000
          return new Response(null, { status: scenario === 'unknown' ? 500 : 204 })
        }
        if (path.endsWith('/pause')) return new Response(null, { status: 204 })
        if (path === '/files') return new Response(Date.now() < expiry ? 'alive' : 'expired')
        return new Response(null, { status: 500 })
      },
    })
    const endpoint = `http://127.0.0.1:${server.port}`
    const owner = new AbortController()
    let session: Awaited<ReturnType<typeof openE2BSandbox>> | undefined
    try {
      session = await openE2BSandbox(
        {
          apiURL: endpoint,
          sandboxURL: endpoint,
          apiKey: 'fixture',
          template: 'fixture',
          timeoutMs: 1000,
          assignment: { threadID: 'thread', runID: 'run', fence: 1 },
          onFailure: () => {
            failures++
            failed.resolve()
          },
        },
        owner.signal,
      )
      if (scenario === 'idle') {
        await Bun.sleep(1400)
        expect(await session.read({ path: '/idle', signal: owner.signal })).toBe('alive')
        expect(paths.filter((path) => path.endsWith('/timeout')).length).toBeGreaterThan(1)
      }
      if (scenario !== 'idle') {
        await Promise.race([entered.promise, Bun.sleep(1500)])
        expect(paths.filter((path) => path.endsWith('/timeout'))).toHaveLength(1)
      }
      if (scenario === 'unknown') {
        await failed.promise
        expect(failures).toBe(1)
        expect(
          await session.read({ path: '/no-spend', signal: owner.signal }).catch((error) => error),
        ).toBeInstanceOf(Error)
        expect(paths).not.toContain('/files')
      }
      if (scenario === 'cancel') owner.abort(new Error('owner stopped'))
      if (scenario === 'cancel' || scenario === 'close-inflight') {
        let closed = false
        const closing = session.close().finally(() => {
          closed = true
        })
        await Bun.sleep(30)
        expect(closed).toBe(false)
        expect(paths.some((path) => path.endsWith('/pause'))).toBe(false)
        receipt.resolve()
        await closing
        expect(failures).toBe(0)
      }
      const outcome = await session.close().catch((error) => error)
      if (scenario === 'unknown') expect(outcome).toBeInstanceOf(Error)
      const count = paths.length
      await Bun.sleep(400)
      expect(paths.length).toBe(count)
      expect(paths.filter((path) => path.endsWith('/pause'))).toHaveLength(1)
      expect(paths.at(-1)).toBe('/sandboxes/owned-idle/pause')
    } finally {
      receipt.resolve()
      await session?.close().catch(() => {})
      await server.stop(true)
    }
  })
}

for (const scenario of [
  'get-failure',
  'foreign-sdk',
  'foreign-metadata',
  'cleanup-failure',
] as const) {
  test(`reconnected known allocation joins owned cleanup: ${scenario}`, async () => {
    const paths: string[] = []
    const pauseEntered = Promise.withResolvers<void>()
    const pauseReceipt = Promise.withResolvers<void>()
    let reads = 0
    const getFails = scenario === 'get-failure' || scenario === 'cleanup-failure'
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        paths.push(`${request.method} ${path}`)
        if (request.method === 'GET') {
          reads++
          if (reads === 2 && getFails) return new Response('ownership unavailable', { status: 500 })
          return Response.json({
            sandboxID: reads === 2 && scenario === 'foreign-metadata' ? 'foreign' : 'known',
            state: 'paused',
            metadata: { platform: 'vid', threadID: 'thread', runID: 'previous', fence: '1' },
          })
        }
        if (path.endsWith('/connect'))
          return Response.json({
            sandboxID: scenario === 'foreign-sdk' ? 'foreign' : 'known',
            envdVersion: '0.6.2',
            envdAccessToken: 'fixture',
          })
        if (path === '/sandboxes/known/pause') {
          pauseEntered.resolve()
          await pauseReceipt.promise
          return new Response(null, { status: scenario === 'cleanup-failure' ? 500 : 204 })
        }
        return new Response(null, { status: 500 })
      },
    })
    const endpoint = `http://127.0.0.1:${server.port}`
    try {
      let settled = false
      const pending = openE2BSandbox(
        {
          apiURL: endpoint,
          sandboxURL: endpoint,
          apiKey: 'fixture',
          template: 'fixture',
          timeoutMs: 120000,
          assignment: {
            threadID: 'thread',
            runID: 'next',
            fence: 2,
            nativeRef: { provider: 'e2b', id: 'known' },
          },
        },
        new AbortController().signal,
      )
        .then(async (session) => {
          // E2B 2.52 constructs connect's sandboxId from its argument, not the
          // response sandboxID. Even a foreign wire ID cannot become authority.
          expect(scenario).toBe('foreign-sdk')
          expect(session.nativeRef.id).toBe('known')
          await session.close()
          return new Error('SDK retained the assigned identity')
        })
        .catch((error) => error)
        .finally(() => {
          settled = true
        })
      await Promise.race([pauseEntered.promise, Bun.sleep(100)])
      expect(settled).toBe(false)
      pauseReceipt.resolve()
      const error = await pending
      expect(error).toBeInstanceOf(Error)
      if (scenario === 'cleanup-failure') {
        expect(error).toBeInstanceOf(AggregateError)
        expect(error.errors).toHaveLength(2)
      } else if (scenario === 'get-failure') expect(String(error)).toContain('500')
      expect(paths.filter((path) => path.endsWith('/pause'))).toEqual([
        'POST /sandboxes/known/pause',
      ])
      expect(paths.some((path) => path.includes('/foreign'))).toBe(false)
    } finally {
      pauseReceipt.resolve()
      await server.stop(true)
    }
  })
}
