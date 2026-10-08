import { expect, test } from 'bun:test'
import { CapabilityRejectedError, type AgentHarness, type ExecutionWrites } from '../contract'
import { executeRun } from '../execution/execute-run'
import { openE2BSandbox } from './e2b'

type Operation = 'execute' | 'write' | 'writeBytes'

function localFixture(dispatchedAbort = false, correctionAcknowledged = true) {
  const toolAbort = new AbortController()
  const paths: string[] = []
  const facts = { reservations: 0, corrections: 0, quarantines: 0, models: 0 }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      paths.push(path)
      if (path === '/v2/sandboxes')
        return Response.json({
          sandboxID: 'owned-admission',
          envdVersion: '0.6.2',
          envdAccessToken: 'fixture',
        })
      if (path === '/sandboxes/owned-admission/pause') return new Response(null, { status: 204 })
      if (path === '/files' && dispatchedAbort) {
        toolAbort.abort(new DOMException('Dispatched write aborted', 'AbortError'))
        return Response.json([])
      }
      return new Response('Unexpected dispatch', { status: 500 })
    },
  })
  const writes: ExecutionWrites = {
    beginWorkspaceTransition: async () => true,
    settleWorkspaceTransition: async () => true,
    reserveModel: async () => {
      facts.models++
      return 'allowed'
    },
    beginEffect: async () => {
      facts.reservations++
      return 'allowed'
    },
    rejectEffect: async () => {
      facts.corrections++
      return correctionAcknowledged
    },
    checkpoint: async () => true,
    saveSandbox: async () => true,
    renew: async () => 'renewed',
    quarantine: async () => {
      facts.quarantines++
    },
    appendText: async () => true,
    complete: async () => 'completed',
    fail: async () => 'failed',
    cancel: async () => 'cancelled',
  }
  return { server, writes, paths, facts, toolAbort }
}

type Fixture = ReturnType<typeof localFixture>

function runFixture(fixture: Fixture, run: AgentHarness['run']) {
  const endpoint = `http://127.0.0.1:${fixture.server.port}`
  return executeRun(
    {
      threadID: crypto.randomUUID(),
      runID: crypto.randomUUID(),
      text: 'Use the assigned tool',
      fence: 1,
      ownerID: 'fixture',
      engine: 'pi',
      nativeSessionID: crypto.randomUUID(),
      deadlineAt: new Date(Date.now() + 60000),
      restoring: false,
      restoreWorkspace: false,
    },
    {
      writes: fixture.writes,
      harness: { run },
      openSandbox: (assignment, signal) =>
        openE2BSandbox(
          {
            apiURL: endpoint,
            sandboxURL: endpoint,
            apiKey: 'fixture',
            template: 'fixture',
            timeoutMs: 120000,
            assignment,
          },
          signal,
        ),
      // This seam exposes the actual guarded binary-write capability, without
      // an asset helper's earlier abort check hiding the sandbox admission gate.
      fileTools: (_assignment, sandbox) => ({
        assigned: [],
        prepared: [],
        importFile: async ({ path, signal }) => {
          const bytes = new Uint8Array([1])
          await sandbox.writeBytes(path, bytes, signal)
          return { bytes, mimeType: 'application/octet-stream' }
        },
        exportFile: async () => {
          throw new Error('Unexpected export')
        },
      }),
    },
    { leaseMs: 5000, pollMs: 10000, signal: AbortSignal.timeout(5000) },
  )
}

async function invokeTool(
  input: Parameters<AgentHarness['run']>[0],
  operation: Operation,
  signal: AbortSignal,
) {
  if (operation === 'execute') return await input.tools.execute({ command: 'true', signal })
  if (operation === 'write')
    return await input.tools.write({ path: '/work/output', content: 'fixture', signal })
  return await input.fileTools!.importFile({ assetID: 'fixture', path: '/work/output', signal })
}

for (const operation of ['execute', 'write', 'writeBytes'] as const) {
  test(`${operation}: local abort corrects only its reservation and permits a safe next model`, async () => {
    const fixture = localFixture()
    const cause = new DOMException('Tool cancelled before dispatch', 'AbortError')
    fixture.toolAbort.abort(cause)
    try {
      const outcome = await runFixture(fixture, async (input) => {
        let rejection: unknown
        try {
          await invokeTool(input, operation, fixture.toolAbort.signal)
        } catch (error) {
          rejection = error
        }
        expect(rejection).toBeInstanceOf(CapabilityRejectedError)
        expect(rejection).toHaveProperty('cause', cause)
        await input.beforeModel()
        return { text: 'Corrected without repeating a mutation' }
      })
      expect(outcome).toBe('completed')
      expect(fixture.facts).toEqual({ reservations: 1, corrections: 1, quarantines: 0, models: 1 })
      expect(fixture.paths).toEqual(['/v2/sandboxes', '/sandboxes/owned-admission/pause'])
    } finally {
      await fixture.server.stop(true)
    }
  })
}

test('failed local-abort correction retains uncertainty and blocks further spending', async () => {
  const fixture = localFixture(false, false)
  fixture.toolAbort.abort()
  try {
    const outcome = await runFixture(fixture, async (input) => {
      const rejection = await invokeTool(input, 'write', fixture.toolAbort.signal).catch(
        (error: unknown) => error,
      )
      expect(rejection).toBeInstanceOf(AggregateError)
      const refusal = await input.beforeModel().catch((error: unknown) => error)
      expect(refusal).toBeDefined()
      return { text: 'Must not complete' }
    })
    expect(outcome).toBe('failed')
    expect(fixture.facts).toEqual({ reservations: 1, corrections: 1, quarantines: 1, models: 0 })
    expect(fixture.paths).toEqual(['/v2/sandboxes', '/sandboxes/owned-admission/pause'])
  } finally {
    await fixture.server.stop(true)
  }
})

test('local rejection cannot erase uncertainty from a previously dispatched write', async () => {
  const fixture = localFixture(true)
  const endpoint = `http://127.0.0.1:${fixture.server.port}`
  let session: Awaited<ReturnType<typeof openE2BSandbox>> | undefined
  try {
    session = await openE2BSandbox(
      {
        apiURL: endpoint,
        sandboxURL: endpoint,
        apiKey: 'fixture',
        template: 'fixture',
        timeoutMs: 120000,
        assignment: { threadID: crypto.randomUUID(), runID: crypto.randomUUID(), fence: 1 },
      },
      AbortSignal.timeout(5000),
    )
    const request = { path: '/work/output', content: 'fixture', signal: fixture.toolAbort.signal }
    const dispatched = await session.write(request).catch((error: unknown) => error)
    expect(dispatched).toBeDefined()
    expect(dispatched).not.toBeInstanceOf(CapabilityRejectedError)
    const local = await session.write(request).catch((error: unknown) => error)
    expect(local).toBeInstanceOf(CapabilityRejectedError)
    const close = await session.close().catch((error: unknown) => error)
    expect(close).toEqual(new Error('Sandbox recovery required: mutative outcome uncertain'))
    expect(fixture.paths).toEqual(['/v2/sandboxes', '/files', '/sandboxes/owned-admission/pause'])
  } finally {
    await session?.close().catch(() => {})
    await fixture.server.stop(true)
  }
})

test('abort after actual file dispatch is unknown, never a reservation correction', async () => {
  const fixture = localFixture(true)
  try {
    const failure = await runFixture(fixture, async (input) => {
      await input.tools.write({
        path: '/work/output',
        content: 'fixture',
        signal: fixture.toolAbort.signal,
      })
      return { text: 'Must not complete' }
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(fixture.facts).toEqual({ reservations: 1, corrections: 0, quarantines: 1, models: 0 })
    expect(fixture.paths).toEqual(['/v2/sandboxes', '/files', '/sandboxes/owned-admission/pause'])
  } finally {
    await fixture.server.stop(true)
  }
})
