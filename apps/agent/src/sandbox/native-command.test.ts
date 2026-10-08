import { expect, test } from 'bun:test'
import { openE2BSandbox } from './e2b'
import { executeRun } from '../execution/execute-run'
import { CapabilityRejectedError } from '../contract'

function frame(value: unknown, flags = 0) {
  const data = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(data.length, 1)
  return Buffer.concat([header, data])
}

// Local HTTP/Connect JSON envelopes are fixture inputs, not an SDK/RPC replica.
// The installed SDK's native Process descriptor parses bytes and owns cleanup.
type Scenario = 'success' | 'nonzero' | 'quota' | 'lost-start' | 'abort-known'

function fixture(scenario: Scenario) {
  const started = Promise.withResolvers<void>()
  const killReceived = Promise.withResolvers<void>()
  const killReceipt = Promise.withResolvers<void>()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const paths: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      paths.push(path)
      if (path === '/v2/sandboxes')
        return Response.json({
          sandboxID: 'owned-command',
          envdVersion: '0.6.2',
          envdAccessToken: 'fixture',
        })
      if (path.endsWith('/Start')) {
        if (scenario === 'lost-start') return new Response('lost start', { status: 502 })
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              controller = stream
              stream.enqueue(frame({ event: { start: { pid: 42 } } }))
              started.resolve()
              if (scenario === 'abort-known') return
              for (const event of initialFrames(scenario)) stream.enqueue(event)
              stream.close()
            },
            cancel() {
              controller = undefined
            },
          }),
          { headers: { 'content-type': 'application/connect+json' } },
        )
      }
      if (path.endsWith('/SendSignal')) {
        killReceived.resolve()
        if (scenario === 'abort-known') {
          await killReceipt.promise
          controller?.enqueue(frame({ event: { end: { exitCode: 137, exited: true } } }))
          controller?.enqueue(frame({}, 2))
          controller?.close()
        }
        return Response.json({})
      }
      if (path.endsWith('/pause')) return new Response(null, { status: 204 })
      return new Response('unexpected route', { status: 500 })
    },
  })
  const endpoint = `http://127.0.0.1:${server.port}`
  return {
    paths,
    started,
    killReceived,
    killReceipt,
    options: {
      apiURL: endpoint,
      sandboxURL: endpoint,
      apiKey: 'owned-fixture',
      template: 'fixture',
      timeoutMs: 120000,
      assignment: { runID: 'owned', threadID: 'owned', fence: 1 },
    },
    stop: () => {
      killReceipt.resolve()
      return server.stop(true)
    },
  }
}

for (const scenario of ['success', 'nonzero', 'quota', 'lost-start'] as const) {
  test(`ordinary application native command: ${scenario}`, async () => {
    const native = fixture(scenario)
    const signal = new AbortController().signal
    try {
      const session = await openE2BSandbox(native.options, signal)
      const outcome = await session
        .execute({ command: 'fixture', signal })
        .catch((error: unknown) => error)
      if (scenario === 'success' || scenario === 'nonzero') {
        expect(outcome).toEqual({
          stdout: 'output',
          stderr: 'diagnostic',
          exitCode: scenario === 'nonzero' ? 7 : 0,
        })
        await session.close()
      } else {
        expect(outcome).toBeInstanceOf(Error)
        expect(
          await session.execute({ command: 'no replay', signal }).catch((error: unknown) => error),
        ).toBeInstanceOf(Error)
        expect(await session.close().catch((error: unknown) => error)).toBeInstanceOf(Error)
      }
      await session.close().catch(() => {})
      expect(native.paths.filter((path) => path.endsWith('/Start'))).toHaveLength(1)
      expect(native.paths.filter((path) => path.endsWith('/SendSignal'))).toHaveLength(
        scenario === 'quota' ? 1 : 0,
      )
      expect(native.paths.filter((path) => path.endsWith('/pause'))).toHaveLength(1)
    } finally {
      await native.stop()
    }
  })
}

test('cancellation kills the assigned PID without replay and leaves an uncertain command conservative', async () => {
  const native = fixture('abort-known')
  const owner = new AbortController()
  try {
    const session = await openE2BSandbox(native.options, owner.signal)
    let settled = false
    const command = session
      .execute({ command: 'fixture', signal: owner.signal })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true
      })
    await native.started.promise
    await Bun.sleep(10)
    owner.abort()
    await native.killReceived.promise
    await Bun.sleep(10)
    expect(settled).toBe(false)
    native.killReceipt.resolve()
    expect(await command).toBeInstanceOf(Error)
    expect(await session.close().catch((error: unknown) => error)).toBeInstanceOf(Error)
    expect(native.paths.filter((path) => path.endsWith('/Start'))).toHaveLength(1)
    expect(native.paths.filter((path) => path.endsWith('/SendSignal'))).toHaveLength(1)
  } finally {
    native.killReceipt.resolve()
    await native.stop()
  }
})

function initialFrames(scenario: Scenario) {
  const quota = scenario === 'quota'
  return [
    frame({
      event: {
        data: {
          stdout: Buffer.from(quota ? 'x'.repeat(131072) : 'output').toString('base64'),
        },
      },
    }),
    frame({
      event: {
        data: {
          stderr: Buffer.from(quota ? 'y'.repeat(131073) : 'diagnostic').toString('base64'),
        },
      },
    }),
    frame({
      event: {
        end: {
          exitCode: scenario === 'nonzero' ? 7 : 0,
          exited: true,
          error: '',
        },
      },
    }),
    frame({}, 2),
  ]
}

test('native mutative quota stops spending and quarantines the same persisted allocation', async () => {
  const native = fixture('quota')
  const lease = {
    ...native.options.assignment,
    text: 'fixture',
    ownerID: 'owned',
    engine: 'pi' as const,
    nativeSessionID: crypto.randomUUID(),
    deadlineAt: new Date(Date.now() + 60000),
    restoring: false,
    restoreWorkspace: false,
  }
  const events: string[] = []
  try {
    const outcome = await executeRun(
      lease,
      {
        writes: {
          beginWorkspaceTransition: async () => true,
          settleWorkspaceTransition: async () => true,
          reserveModel: async () => 'allowed',
          beginEffect: async () => 'allowed',
          rejectEffect: async () => true,
          checkpoint: async () => true,
          renew: async () => 'renewed',
          saveSandbox: async (_lease, ref) => {
            events.push(`save:${ref.id}`)
            return true
          },
          quarantine: async (_lease, reason) => {
            events.push(`quarantine:${reason}`)
          },
          appendText: async () => {
            events.push('text')
            return true
          },
          complete: async () => {
            events.push('complete')
            return 'completed'
          },
          fail: async () => {
            events.push('fail')
            return 'failed'
          },
          cancel: async () => {
            events.push('cancel')
            return 'cancelled'
          },
        },
        openSandbox: async (_lease, signal) => await openE2BSandbox(native.options, signal),
        harness: {
          run: async ({ tools, signal }) => {
            expect(
              await tools.execute({ command: 'quota', signal }).catch((error: unknown) => error),
            ).toBeInstanceOf(Error)
            expect(signal.aborted).toBe(true)
            expect(
              await tools
                .execute({ command: 'no followup', signal })
                .catch((error: unknown) => error),
            ).toBeInstanceOf(Error)
            return { text: 'not committed' }
          },
        },
      },
      { leaseMs: 60000, pollMs: 1000, signal: new AbortController().signal },
    ).catch((error: unknown) => error)
    expect(outcome).toBeInstanceOf(AggregateError)
    expect(events).toEqual(['save:owned-command', 'quarantine:execution-error', 'fail'])
    expect(native.paths.filter((path) => path.endsWith('/Start'))).toHaveLength(1)
    expect(native.paths.filter((path) => path.endsWith('/pause'))).toHaveLength(1)
    expect(native.paths.filter((path) => path === '/v2/sandboxes')).toHaveLength(1)
  } finally {
    await native.stop()
  }
})

test('foreground command outlives original guest TTL with owned, joined timeout renewal', async () => {
  const requests: string[] = []
  const renewed = Promise.withResolvers<void>()
  let expiry = Date.now() + 1000
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      requests.push(path)
      if (path === '/v2/sandboxes')
        return Response.json({
          sandboxID: 'owned-long',
          envdVersion: '0.6.2',
          envdAccessToken: 'fixture',
        })
      if (path.endsWith('/timeout')) {
        expect(await request.json()).toEqual({ timeout: 1 })
        expiry = Date.now() + 1000
        renewed.resolve()
        return new Response(null, { status: 204 })
      }
      if (path.endsWith('/Start'))
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(frame({ event: { start: { pid: 42 } } }))
              await Bun.sleep(1400)
              controller.enqueue(
                frame({
                  event: {
                    data: {
                      stdout: Buffer.from(Date.now() < expiry ? 'alive' : 'expired').toString(
                        'base64',
                      ),
                    },
                  },
                }),
              )
              controller.enqueue(frame({ event: { end: { exitCode: 0, exited: true } } }))
              controller.enqueue(frame({}, 2))
              controller.close()
            },
          }),
          { headers: { 'content-type': 'application/connect+json' } },
        )
      if (path.endsWith('/pause')) return new Response(null, { status: 204 })
      return new Response(null, { status: 500 })
    },
  })
  const endpoint = `http://127.0.0.1:${server.port}`
  try {
    const signal = AbortSignal.timeout(5000)
    const session = await openE2BSandbox(
      {
        apiURL: endpoint,
        sandboxURL: endpoint,
        apiKey: 'fixture',
        template: 'fixture',
        timeoutMs: 1000,
        assignment: { threadID: 'thread', runID: 'run', fence: 1 },
      },
      signal,
    )
    expect(await session.execute({ command: 'long foreground', signal })).toEqual({
      stdout: 'alive',
      stderr: '',
      exitCode: 0,
    })
    await renewed.promise
    await session.close()
    const count = requests.length
    await Bun.sleep(400)
    expect(requests.length).toBe(count)
    expect(requests.filter((path) => path.endsWith('/timeout')).length).toBeGreaterThan(1)
    expect(requests.at(-1)).toBe('/sandboxes/owned-long/pause')
  } finally {
    await server.stop(true)
  }
})

test('eight command admissions reject locally without replay or poisoning the guest', async () => {
  const native = fixture('success')
  try {
    const signal = AbortSignal.timeout(5000)
    const session = await openE2BSandbox(native.options, signal)
    expect(
      await session.execute({ command: '', signal }).catch((error: unknown) => error),
    ).toBeInstanceOf(CapabilityRejectedError)
    for (let i = 0; i < 8; i++)
      expect((await session.execute({ command: 'owned', signal })).exitCode).toBe(0)
    expect(
      await session.execute({ command: 'ninth', signal }).catch((error: unknown) => error),
    ).toBeInstanceOf(CapabilityRejectedError)
    expect(native.paths.filter((path) => path.endsWith('/Start'))).toHaveLength(8)
    await session.close()
  } finally {
    await native.stop()
  }
})

for (const status of [409, 502]) {
  test(`unknown timeout renewal (${status}) stops the owned PID and never retries renewal`, async () => {
    const paths: string[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        paths.push(path)
        if (path === '/v2/sandboxes')
          return Response.json({
            sandboxID: 'owned-renewal',
            envdVersion: '0.6.2',
            envdAccessToken: 'fixture',
          })
        if (path.endsWith('/Start'))
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(frame({ event: { start: { pid: 42 } } }))
              },
            }),
            { headers: { 'content-type': 'application/connect+json' } },
          )
        if (path.endsWith('/timeout')) return new Response(null, { status })
        if (path.endsWith('/SendSignal')) return Response.json({})
        if (path.endsWith('/pause')) return new Response(null, { status: 204 })
        return new Response(null, { status: 500 })
      },
    })
    const endpoint = `http://127.0.0.1:${server.port}`
    try {
      const signal = AbortSignal.timeout(5000)
      const session = await openE2BSandbox(
        {
          apiURL: endpoint,
          sandboxURL: endpoint,
          apiKey: 'fixture',
          template: 'fixture',
          timeoutMs: 1000,
          assignment: { threadID: 'thread', runID: 'run', fence: 1 },
        },
        signal,
      )
      expect(
        await session.execute({ command: 'owned', signal }).catch((error: unknown) => error),
      ).toBeInstanceOf(Error)
      expect(
        await session.execute({ command: 'never retry', signal }).catch((error: unknown) => error),
      ).toBeInstanceOf(Error)
      expect(await session.close().catch((error: unknown) => error)).toBeInstanceOf(Error)
      expect(paths.filter((path) => path.endsWith('/Start'))).toHaveLength(1)
      expect(paths.filter((path) => path.endsWith('/timeout'))).toHaveLength(1)
      expect(paths.filter((path) => path.endsWith('/SendSignal'))).toHaveLength(1)
      await Bun.sleep(400)
      expect(paths.filter((path) => path.endsWith('/timeout'))).toHaveLength(1)
    } finally {
      await server.stop(true)
    }
  })
}
