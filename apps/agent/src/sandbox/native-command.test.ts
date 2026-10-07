import { expect, test } from 'bun:test'
import { openE2BSandbox } from './e2b'
import { executeRun } from '../execution/execute-run'

function frame(value: unknown, flags = 0) {
  const data = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(data.length, 1)
  return Buffer.concat([header, data])
}

// Local HTTP/Connect JSON envelopes are fixture inputs, not an SDK/RPC replica.
// The installed SDK's native Process descriptor parses bytes and owns cleanup.
function fixture(scenario: string) {
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
              if (scenario.startsWith('abort')) return
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
        if (!scenario.startsWith('abort')) return Response.json({})
        await killReceipt.promise
        finishKilled(scenario, controller)
        return killResponse(scenario)
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
      lease: {
        runID: 'owned',
        threadID: 'owned',
        commandID: 'owned',
        messageID: 'owned',
        text: 'fixture',
        history: [],
        fence: 1,
        ownerID: 'owned',
      },
    },
    stop: () => {
      killReceipt.resolve()
      return server.stop(true)
    },
  }
}

for (const scenario of ['success', 'nonzero', 'quota', 'lost-start']) {
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
    const command = session
      .execute({ command: 'fixture', signal: owner.signal })
      .catch((error: unknown) => error)
    await native.started.promise
    await Bun.sleep(10)
    owner.abort()
    await native.killReceived.promise
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

function killResponse(scenario: string) {
  if (scenario.endsWith('-false'))
    return Response.json({ code: 'not_found', message: 'owned PID missing' }, { status: 404 })
  if (scenario.endsWith('-reject'))
    return Response.json({ code: 'unavailable', message: 'lost kill receipt' }, { status: 503 })
  return Response.json({})
}

function initialFrames(scenario: string) {
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
          error: scenario === 'end-quota' ? 'z'.repeat(262145) : '',
        },
      },
    }),
    frame({}, 2),
  ]
}

function finishKilled(
  scenario: string,
  controller: ReadableStreamDefaultController<Uint8Array> | undefined,
) {
  if (scenario.startsWith('abort-quota'))
    controller?.enqueue(
      frame({
        event: {
          data: {
            stdout: Buffer.from('q'.repeat(262145)).toString('base64'),
          },
        },
      }),
    )
  if (scenario !== 'abort-no-end')
    controller?.enqueue(frame({ event: { end: { exitCode: 137, exited: true } } }))
  controller?.enqueue(frame({}, 2))
  controller?.close()
}

test('native mutative quota stops spending and quarantines the same persisted allocation', async () => {
  const native = fixture('quota')
  const events: string[] = []
  try {
    const outcome = await executeRun(
      native.options.lease,
      {
        writes: {
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
          turn: async ({ tools, signal }) => {
            expect(
              await tools.execute({ command: 'quota', signal }).catch((error: unknown) => error),
            ).toBeInstanceOf(Error)
            expect(signal.aborted).toBe(true)
            expect(
              await tools
                .execute({ command: 'no followup', signal })
                .catch((error: unknown) => error),
            ).toBeInstanceOf(Error)
            return { text: 'not committed', history: [] }
          },
        },
      },
      { leaseMs: 60000, pollMs: 1000, signal: new AbortController().signal },
    )
    expect(outcome).toBe('failed')
    expect(events).toEqual(['save:owned-command', 'quarantine:execution-error'])
    expect(native.paths.filter((path) => path.endsWith('/Start'))).toHaveLength(1)
    expect(native.paths.filter((path) => path.endsWith('/pause'))).toHaveLength(1)
    expect(native.paths.filter((path) => path === '/v2/sandboxes')).toHaveLength(1)
  } finally {
    await native.stop()
  }
})
