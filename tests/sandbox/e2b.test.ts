import { afterAll, describe, expect, test } from 'bun:test'
import { E2B, type Sandbox } from 'e2b'
import { openE2BSandbox } from '../../apps/agent/src/sandbox/e2b'

function validateEmbedEndpoint(apiURL: string, sandboxURL: string, port: number) {
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    new URL(apiURL).hostname !== '127.0.0.1' ||
    new URL(sandboxURL).hostname !== '127.0.0.1'
  )
    throw new Error('Sandbox tests require explicitly configured local E2B Embed')
}

describe('owned Embed environment (opt-in)', () => {
  // This suite requires the owned local Embed endpoint; never default to a paid Cloud account.
  const apiURL = process.env.E2B_API_URL
  const sandboxURL = process.env.E2B_SANDBOX_URL
  const apiKey = process.env.E2B_API_KEY
  const probeHost = process.env.E2B_TEST_HOST
  const probePort = Number(process.env.E2B_TEST_PORT)
  if (
    [apiURL, sandboxURL, apiKey, probeHost, process.env.E2B_TEST_PORT].every(
      (value) => value === undefined,
    )
  ) {
    test.skip('requires explicitly configured owned local Embed', () => {})
    return
  }
  if (!apiURL || !sandboxURL || !apiKey || !probeHost)
    throw new Error('Sandbox tests require explicitly configured local E2B Embed')
  validateEmbedEndpoint(apiURL, sandboxURL, probePort)
  const client = new E2B({
    apiUrl: apiURL,
    sandboxUrl: sandboxURL,
    apiKey,
    retries: 0,
    debug: false,
  })
  const connection = { apiURL, sandboxURL, apiKey }
  const networkHost = probeHost
  const ownedRuns: string[] = []
  function options() {
    const runID = crypto.randomUUID()
    ownedRuns.push(runID)
    return {
      ...connection,
      template: 'base',
      timeoutMs: 120000,
      runID,
      assignment: { runID, threadID: crypto.randomUUID(), fence: 1 },
    }
  }
  async function assigned(runID: string) {
    const paginator = client.Sandbox.list({ query: { metadata: { runID } } })
    const resources = []
    while (paginator.hasNext) resources.push(...(await paginator.nextItems()))
    return resources
  }
  async function waitForStart(remote: Sandbox, marker: string) {
    const deadline = Date.now() + 10000
    while (!(await remote.files.exists(marker))) {
      if (Date.now() > deadline) throw new Error('Command did not start')
      await Bun.sleep(20)
    }
  }
  async function cleanupRun(runID: string, failures: unknown[]) {
    let resources
    try {
      resources = await assigned(runID)
    } catch (error) {
      failures.push(error)
      return
    }
    for (const sandbox of resources) {
      try {
        await client.Sandbox.kill(sandbox.sandboxId)
      } catch (error) {
        failures.push(error)
      }
    }
  }
  afterAll(async () => {
    // Keep correlation evidence after the runner's writable layer is removed.
    console.log('Owned E2B test run IDs:', JSON.stringify(ownedRuns))
    const failures: unknown[] = []
    await Promise.all(ownedRuns.map((runID) => cleanupRun(runID, failures)))
    if (failures.length) throw new AggregateError(failures, 'Owned sandbox cleanup failed')
  })

  test('assigned tools use the SDK and retain nonzero exit diagnostics', async () => {
    const input = options()
    const signal = new AbortController().signal
    const sandbox = await openE2BSandbox(input, signal)
    try {
      expect((await client.Sandbox.getInfo(sandbox.nativeRef.id)).lifecycle).toEqual({
        onTimeout: 'kill',
        autoResume: false,
      })
      await sandbox.write({
        path: '/home/user/result.txt',
        content: 'hello',
        signal,
      })
      expect(await sandbox.read({ path: '/home/user/result.txt', signal })).toBe('hello')
      expect(
        await sandbox.execute({
          command: 'printf output; printf diagnostic >&2; exit 7',
          signal,
        }),
      ).toEqual({ stdout: 'output', stderr: 'diagnostic', exitCode: 7 })
    } finally {
      await sandbox.close()
    }
    await sandbox.close()
    expect((await assigned(input.runID))[0]?.state).toBe('paused')
  }, 30000)

  test('aborted allocation does not create a sandbox', async () => {
    const input = options()
    const signal = AbortSignal.abort()
    expect(openE2BSandbox(input, signal)).rejects.toThrow()
    expect(await assigned(input.runID)).toHaveLength(0)
  }, 30000)

  test('credentials stay private and outbound HTTP policy blocks the owned probe', async () => {
    const input = options()
    const signal = new AbortController().signal
    const sandbox = await openE2BSandbox(input, signal)
    let requests = 0
    let probe: ReturnType<typeof Bun.serve> | undefined
    const failures: unknown[] = []
    try {
      probe = Bun.serve({
        hostname: networkHost,
        port: probePort,
        fetch: () => {
          requests++
          return new Response('owned-network-probe')
        },
      })
      const command = `curl --noproxy "*" --max-time 2 -fsS http://${networkHost}:${probe.port}`
      const env = await sandbox.execute({ command: 'env', signal })
      expect(env.stdout).not.toContain(input.apiKey)
      expect(env.stdout).not.toContain('MODEL_API_KEY=')
      expect(env.stdout).not.toContain('DATABASE_URL=')
      expect(env.stdout).not.toContain('TURN_TOKEN_SECRET=')
      expect((await sandbox.execute({ command: 'command -v curl', signal })).exitCode).toBe(0)
      const controlInput = options()
      const control = await client.Sandbox.create('base', {
        timeoutMs: 120000,
        metadata: { runID: controlInput.runID },
        allowInternetAccess: true,
        network: { allowOut: [networkHost] },
      })
      const controlFailures: unknown[] = []
      try {
        expect((await control.commands.run(command)).stdout).toBe('owned-network-probe')
      } catch (cause) {
        controlFailures.push(cause)
      }
      await control.kill().catch((cause: unknown) => {
        controlFailures.push(cause)
      })
      if (controlFailures.length > 1)
        throw new AggregateError(controlFailures, 'Control sandbox failed')
      if (controlFailures.length === 1) throw controlFailures[0]
      const network = await sandbox.execute({
        command,
        signal,
      })
      expect(network.exitCode).not.toBe(0)
      expect(requests).toBe(1)
    } catch (cause) {
      failures.push(cause)
    }
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => probe?.stop(true)),
      Promise.resolve().then(() => sandbox.close()),
    ])
    for (const result of cleanup) if (result.status === 'rejected') failures.push(result.reason)
    if (failures.length > 1) throw new AggregateError(failures, 'Owned network probe failed')
    if (failures.length === 1) throw failures[0]
  }, 30000)

  test('binary workspace IO preserves arbitrary bytes using official SDK byte reads and writes', async () => {
    const input = options()
    const signal = AbortSignal.timeout(15000)
    const sandbox = await openE2BSandbox(input, signal)
    try {
      const bytes = new Uint8Array([0, 255, 128, 13, 10, 0])
      await sandbox.writeBytes('/home/user/binary.bin', bytes, signal)
      expect(await sandbox.readBytes('/home/user/binary.bin', signal, 6)).toEqual(bytes)
    } finally {
      await sandbox.close()
    }
    expect((await assigned(input.runID))[0]?.state).toBe('paused')
  }, 30000)

  test('filesystem-only pause resumes the same native ID with arbitrary-path files and no old process', async () => {
    const input = options()
    const signal = AbortSignal.timeout(60000)
    const sandbox = await openE2BSandbox(input, signal)
    const reference = sandbox.nativeRef
    expect(
      (
        await sandbox.execute({
          command: 'mkdir -p /home/user/agent-chosen; printf saved > /home/user/agent-chosen/note',
          signal,
        })
      ).exitCode,
    ).toBe(0)
    const active = await client.Sandbox.connect(reference.id)
    const bootID = await active.files.read('/proc/sys/kernel/random/boot_id')
    const background = await active.commands.run(
      'printf ready > /home/user/agent-chosen/started; sleep 15; printf old > /home/user/agent-chosen/continued',
      { background: true },
    )
    await waitForStart(active, '/home/user/agent-chosen/started')
    expect((await active.commands.run(`kill -0 ${background.pid}`)).exitCode).toBe(0)
    await sandbox.close()
    // Default restore is a characterization probe: a real filesystem-only
    // snapshot must cold-boot even without the production reboot option.
    const restored = await client.Sandbox.connect(reference.id)
    expect(await restored.files.read('/proc/sys/kernel/random/boot_id')).not.toBe(bootID)
    // The production next-turn allocator requires a settled paused guest, not
    // the running guest left by this separate default-resume characterization.
    expect(await restored.pause({ keepMemory: false })).toBe(true)
    const next = await openE2BSandbox(
      { ...input, assignment: { ...input.assignment, nativeRef: reference } },
      signal,
    )
    try {
      expect(next.nativeRef).toEqual(reference)
      expect(
        await next.read({
          path: '/proc/sys/kernel/random/boot_id',
          signal,
        }),
      ).not.toBe(bootID)
      expect(await next.read({ path: '/home/user/agent-chosen/note', signal })).toBe('saved')
      await Bun.sleep(17000)
      expect(
        (
          await next.execute({
            command: 'test ! -e /home/user/agent-chosen/continued',
            signal,
          })
        ).exitCode,
      ).toBe(0)
    } finally {
      await next.close()
    }
  }, 90000)

  test('foreground cancellation kills the assigned PID and keeps uncertain results isolated', async () => {
    const input = options()
    const owner = new AbortController()
    const sandbox = await openE2BSandbox(input, owner.signal)
    const operation = sandbox
      .execute({
        command: 'printf keep > /home/user/cancel-retained; exec sleep 300',
        signal: owner.signal,
      })
      .catch((error: unknown) => error)
    const remote = await client.Sandbox.connect(sandbox.nativeRef.id)
    await waitForStart(remote, '/home/user/cancel-retained')
    owner.abort()
    expect(await operation).toBeInstanceOf(Error)
    expect(await sandbox.close().catch((error: unknown) => error)).toBeInstanceOf(Error)
  }, 30000)

  test('lost command RPC acknowledgement rejects and isolates the native session without replay', async () => {
    const input = options()
    const signal = AbortSignal.timeout(30000)
    let starts = 0
    // Forward the real start to Embed, then lose its acknowledgement. No SDK mock:
    // the command may still be running, so neither replay nor successful close is safe.
    const proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const upstream = await fetch(`${sandboxURL}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        })
        if (url.pathname.endsWith('/Start')) {
          starts++
          const reader = upstream.body?.getReader()
          await reader?.read()
          await reader?.cancel()
          return new Response('lost owned command acknowledgement', {
            status: 502,
          })
        }
        return upstream
      },
    })
    const sandbox = await openE2BSandbox(
      { ...input, sandboxURL: `http://127.0.0.1:${proxy.port}` },
      signal,
    )
    try {
      expect(
        await sandbox
          .execute({
            command: 'printf accepted > /home/user/unknown-accepted; exec sleep 300',
            signal,
          })
          .catch((error: unknown) => error),
      ).toBeInstanceOf(Error)
      const remote = await client.Sandbox.connect(sandbox.nativeRef.id)
      await waitForStart(remote, '/home/user/unknown-accepted')
      expect(
        await sandbox
          .execute({ command: 'printf replay', signal })
          .catch((error: unknown) => error),
      ).toBeInstanceOf(Error)
      expect(starts).toBe(1)
      expect(await sandbox.close().catch((error: unknown) => error)).toBeInstanceOf(Error)
      expect((await assigned(input.runID))[0]?.sandboxId).toBe(sandbox.nativeRef.id)
      expect((await assigned(input.runID))[0]?.state).toBe('paused')
    } finally {
      await sandbox.close().catch(() => {}) // rejection asserted above; cleanup by ownership below
      await proxy.stop(true)
    }
  }, 45000)

  test('native timeout kills rather than retaining or auto-resuming the owned environment', async () => {
    const input = options()
    const owner = new AbortController()
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(15000)])
    const sandbox = await openE2BSandbox({ ...input, timeoutMs: 2000 }, signal)
    await sandbox.write({
      path: '/home/user/timeout-chosen',
      content: 'owned',
      signal,
    })
    // Active sessions deliberately renew TTL. Model a stopped owner to test
    // the provider's orphan backstop, not an actively owned session's lifetime.
    owner.abort()
    const deadline = Date.now() + 10000
    while ((await assigned(input.runID)).length > 0) {
      if (Date.now() > deadline) throw new Error('Native timeout did not delete sandbox')
      await Bun.sleep(100)
    }
    expect(await assigned(input.runID)).toHaveLength(0)
    expect(
      await openE2BSandbox(
        { ...input, assignment: { ...input.assignment, nativeRef: sandbox.nativeRef } },
        signal,
      ).catch((error: unknown) => error),
    ).toBeInstanceOf(Error)
    expect(await assigned(input.runID)).toHaveLength(0)
    expect(await sandbox.close().catch((error: unknown) => error)).toBeInstanceOf(Error)
  }, 20000)
})

function nativeAPIReceipt(status: number, message: string) {
  return status === 204
    ? new Response(null, { status })
    : Response.json({ code: status, message }, { status })
}

// Actual SDK transport only: these owned HTTP endpoints never allocate a VM.
function nativeHTTPFixture(timeoutStatus = 204, pauseStatus = 204, writeStatus = 200) {
  const writeReceived = Promise.withResolvers<void>()
  const writeReceipt = Promise.withResolvers<void>()
  const timeoutReceived = Promise.withResolvers<void>()
  const timeoutReceipt = Promise.withResolvers<void>()
  const requests: { path: string; method: string; body: unknown }[] = []
  const writes: Uint8Array[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/files' && request.method === 'POST') {
        const form = await request.formData()
        const file = form.get('file')
        if (!(file instanceof Blob)) return new Response(null, { status: 400 })
        writes.push(new Uint8Array(await file.arrayBuffer()))
        requests.push({
          path: url.pathname,
          method: request.method,
          body: writes.at(-1),
        })
        writeReceived.resolve()
        await writeReceipt.promise
        if (writeStatus !== 200)
          return Response.json({ message: 'lost file write receipt' }, { status: writeStatus })
        return Response.json([{ name: 'owned', path: url.searchParams.get('path'), type: 'file' }])
      }
      const body: unknown = request.method === 'POST' ? await request.json() : undefined
      requests.push({ path: url.pathname, method: request.method, body })
      if (url.pathname === '/sandboxes/owned-http')
        return Response.json({
          sandboxID: 'owned-http',
          state: 'paused',
          metadata: {
            platform: 'vid',
            threadID: assignment.threadID,
            runID: assignment.runID,
            fence: String(assignment.fence),
          },
        })
      if (['/v2/sandboxes', '/v2/sandboxes/owned-http/connect'].includes(url.pathname))
        return Response.json({
          sandboxID: 'owned-http',
          envdVersion: '0.6.2',
          envdAccessToken: 'owned-envd-token',
        })
      if (url.pathname === '/sandboxes/owned-http/timeout') {
        timeoutReceived.resolve()
        await timeoutReceipt.promise
        return nativeAPIReceipt(timeoutStatus, 'lost timeout receipt')
      }
      if (url.pathname === '/sandboxes/owned-http/pause')
        return nativeAPIReceipt(pauseStatus, 'already paused')
      return new Response('unexpected owned fixture request', { status: 500 })
    },
  })
  const runID = crypto.randomUUID()
  const assignment = { runID, threadID: crypto.randomUUID(), fence: 1 }
  return {
    requests,
    writes,
    writeReceived,
    writeReceipt,
    timeoutReceived,
    timeoutReceipt,
    options: {
      apiURL: `http://127.0.0.1:${server.port}`,
      sandboxURL: `http://127.0.0.1:${server.port}`,
      apiKey: 'owned-http-key',
      template: 'owned-fixture',
      timeoutMs: 120000,
      assignment,
    },
    async stop() {
      writeReceipt.resolve()
      timeoutReceipt.resolve()
      await server.stop(true)
    },
  }
}

for (const binary of [false, true]) {
  test(`native SDK ${binary ? 'binary' : 'text'} write aborted before ACK isolates session and rejects disk-only close`, async () => {
    const fixture = nativeHTTPFixture()
    const owner = new AbortController()
    const cancellation = new AbortController()
    const signal = cancellation.signal
    const sandbox = await openE2BSandbox(fixture.options, owner.signal)
    try {
      const bytes = new Uint8Array([0, 255, 128])
      const write = binary
        ? sandbox.writeBytes('/owned', bytes, signal)
        : sandbox.write({ path: '/owned', content: 'committed', signal })
      const outcome = write.catch((error: unknown) => error)
      await fixture.writeReceived.promise
      expect(fixture.writes[0]).toEqual(binary ? bytes : new TextEncoder().encode('committed'))
      cancellation.abort(new Error('owned cancellation'))
      expect(await outcome).toBe(cancellation.signal.reason)
      fixture.writeReceipt.resolve()
      expect(
        await sandbox
          .write({
            path: '/later',
            content: 'unsafe',
            signal: owner.signal,
          })
          .catch((error: unknown) => error),
      ).toBeInstanceOf(Error)
      expect(await sandbox.close().catch((error: unknown) => error)).toBeInstanceOf(Error)
      expect(fixture.writes).toHaveLength(1)
      expect(fixture.requests.filter((request) => request.path.endsWith('/pause'))).toEqual([
        {
          path: '/sandboxes/owned-http/pause',
          method: 'POST',
          body: { memory: false },
        },
      ])
    } finally {
      await fixture.stop()
    }
  })
}

test('native SDK pre-dispatch write cancellation sends no RPC and permits disk-only close', async () => {
  const fixture = nativeHTTPFixture()
  const sandbox = await openE2BSandbox(fixture.options, new AbortController().signal)
  try {
    expect(
      await sandbox
        .write({
          path: '/owned',
          content: 'not sent',
          signal: AbortSignal.abort(),
        })
        .catch((error: unknown) => error),
    ).toBeInstanceOf(Error)
    await sandbox.close()
    expect(fixture.writes).toHaveLength(0)
    expect(fixture.requests.at(-1)?.body).toEqual({ memory: false })
  } finally {
    await fixture.stop()
  }
})

for (const binary of [false, true]) {
  test(`native SDK ${binary ? 'binary' : 'text'} write 502 receipt is unknown without replay`, async () => {
    const fixture = nativeHTTPFixture(204, 204, 502)
    const signal = new AbortController().signal
    const sandbox = await openE2BSandbox(fixture.options, signal)
    try {
      fixture.writeReceipt.resolve()
      const outcome = binary
        ? sandbox.writeBytes('/owned', new Uint8Array([0, 255]), signal)
        : sandbox.write({ path: '/owned', content: 'committed', signal })
      expect(await outcome.catch((error: unknown) => error)).toBeInstanceOf(Error)
      expect(
        await sandbox.read({ path: '/later', signal }).catch((error: unknown) => error),
      ).toBeInstanceOf(Error)
      expect(await sandbox.close().catch((error: unknown) => error)).toBeInstanceOf(Error)
      expect(fixture.writes).toHaveLength(1)
      expect(fixture.requests.at(-1)?.body).toEqual({ memory: false })
    } finally {
      await fixture.stop()
    }
  })
}

test('native SDK reconnect uses reboot and already-paused ACK does not establish disk-only settlement', async () => {
  const fixture = nativeHTTPFixture(204, 409)
  try {
    const sandbox = await openE2BSandbox(
      {
        ...fixture.options,
        assignment: {
          ...fixture.options.assignment,
          nativeRef: { provider: 'e2b', id: 'owned-http' },
        },
      },
      new AbortController().signal,
    )
    expect(sandbox.nativeRef).toEqual({ provider: 'e2b', id: 'owned-http' })
    expect(fixture.requests).toEqual([
      { path: '/sandboxes/owned-http', method: 'GET', body: undefined },
      {
        path: '/v2/sandboxes/owned-http/connect',
        method: 'POST',
        body: { timeout: 120, memory: false },
      },
      { path: '/sandboxes/owned-http', method: 'GET', body: undefined },
    ])
    expect(await sandbox.close().catch((error: unknown) => error)).toBeInstanceOf(Error)
    expect(await sandbox.close().catch((error: unknown) => error)).toBeInstanceOf(Error)
    expect(fixture.requests.filter((request) => request.path.endsWith('/pause'))).toHaveLength(1)
    expect(fixture.requests.at(-1)?.body).toEqual({ memory: false })
  } finally {
    await fixture.stop()
  }
})
