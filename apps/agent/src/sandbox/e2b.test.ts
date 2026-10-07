import { expect, test } from 'bun:test'
import { openE2BSandbox } from './e2b'
import { E2B } from 'e2b'
import { executeRun } from '../execution/execute-run'
import type { ExecutionWrites } from '../execution/contract'
import { assignFileTools } from '../harness/files'
import { sha256 } from '@vid/object-storage'
import { createPiHarness } from '../harness/pi'

test('assigned native identity cannot be mutated before durable persistence', async () => {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      requests.push(path)
      if (path === '/v2/sandboxes')
        return Response.json({
          sandboxID: 'owned-identity',
          envdVersion: '0.6.2',
          envdAccessToken: 'fixture',
        })
      if (path === '/sandboxes/owned-identity/pause') return new Response(null, { status: 204 })
      return new Response('unexpected', { status: 500 })
    },
  })
  const endpoint = `http://127.0.0.1:${server.port}`
  let session: Awaited<ReturnType<typeof openE2BSandbox>> | undefined
  try {
    session = await openE2BSandbox(
      {
        apiURL: endpoint,
        sandboxURL: endpoint,
        apiKey: 'fixture',
        template: 'fixture',
        timeoutMs: 120000,
        lease: {
          threadID: crypto.randomUUID(),
          runID: crypto.randomUUID(),
          text: 'identity',
          fence: 1,
          ownerID: 'fixture',
          history: [],
        },
      },
      AbortSignal.timeout(5000),
    )
    const identity = session.nativeRef
    expect(() => Object.assign(identity, { id: 'other-allocation' })).toThrow()
    expect(identity).toEqual({ provider: 'e2b', id: 'owned-identity' })
    expect(session.nativeRef).toBe(identity)
  } finally {
    try {
      await session?.close()
    } finally {
      await server.stop(true)
    }
  }
  expect(requests).toEqual(['/v2/sandboxes', '/sandboxes/owned-identity/pause'])
})

// Official SDK against owned loopback HTTP; no VM, Cloud, SDK doubles or credentials.
for (const rejection of [
  'missing-text',
  'missing-binary',
  'quota',
  'quota-text',
  'unknown-read',
] as const) {
  test(`${rejection} native read outcome distinguishes correctable rejection from unknown RPC`, async () => {
    const requests: string[] = []
    let reads = 0
    let modelRequests = 0
    let correctionContext = ''
    let quarantines = 0
    const oversized = rejection === 'quota-text' ? 'x'.repeat(262145) : new Uint8Array([1, 2, 3, 4])
    const initialTool =
      rejection === 'missing-text' || rejection === 'quota-text' || rejection === 'unknown-read'
        ? 'read'
        : 'export_file'
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        requests.push(`${request.method} ${url.pathname}`)
        if (url.pathname === '/v2/sandboxes')
          return Response.json({
            sandboxID: 'owned-read',
            envdVersion: '0.6.2',
            envdAccessToken: 'fixture',
          })
        if (url.pathname === '/sandboxes/owned-read/pause')
          return new Response(null, { status: 204 })
        if (url.pathname === '/files' && request.method === 'GET') {
          reads++
          if (reads > 1) return new Response('corrected')
          if (rejection.startsWith('quota')) return new Response(oversized)
          return Response.json(
            { message: 'file rejected' },
            { status: rejection === 'unknown-read' ? 502 : 404 },
          )
        }
        if (url.pathname === '/v1/chat/completions') {
          const body: unknown = await request.json()
          modelRequests++
          if (modelRequests === 2) correctionContext = JSON.stringify(body)
          return modelResponse(modelRequests, initialTool)
        }
        return new Response('unexpected request', { status: 500 })
      },
    })
    const endpoint = `http://127.0.0.1:${server.port}`
    const lease = {
      threadID: crypto.randomUUID(),
      runID: crypto.randomUUID(),
      commandID: crypto.randomUUID(),
      messageID: crypto.randomUUID(),
      text: 'Read assigned file',
      fence: 1,
      ownerID: 'fixture',
      history: [],
    }
    const writes: ExecutionWrites = {
      saveSandbox: async () => true,
      renew: async () => 'renewed',
      quarantine: async () => {
        quarantines++
      },
      appendText: async () => true,
      complete: async () => 'completed',
      fail: async () => 'failed',
      cancel: async () => 'cancelled',
    }
    try {
      const result = await executeRun(
        lease,
        {
          writes,
          harness: createPiHarness({
            baseURL: `${endpoint}/v1`,
            key: 'fixture',
            modelID: 'fixture',
            contextWindow: 16384,
            maxOutputTokens: 128,
            reasoning: false,
            input: ['text'],
            systemPrompt: 'Use assigned tools',
          }),
          openSandbox: (lease, signal) =>
            openE2BSandbox(
              {
                apiURL: endpoint,
                sandboxURL: endpoint,
                apiKey: 'fixture',
                template: 'fixture',
                timeoutMs: 120000,
                lease,
              },
              signal,
            ),
          fileTools: assignFileTools(
            {
              read: async () => {
                throw new Error('Unexpected object read')
              },
              put: async (_key, bytes) => ({
                byteLength: bytes.byteLength,
                sha256: sha256(bytes),
              }),
              close: () => {},
            },
            { maxBytes: 3, maxFiles: 10, timeoutMs: 1000 },
          ),
        },
        { leaseMs: 60000, pollMs: 60000, signal: AbortSignal.timeout(5000) },
      )
      expect(result).toBe('completed')
      expect(quarantines).toBe(0)
      if (rejection === 'quota-text') {
        expect(correctionContext).toContain('Sandbox file byte limit exceeded')
        expect(correctionContext.length).toBeLessThan(16384)
      }
      expect(requests.filter((path) => path === 'POST /v1/chat/completions')).toHaveLength(3)
      expect(reads).toBe(2)
      expect(requests.at(-1)).toBe('POST /sandboxes/owned-read/pause')
    } finally {
      await server.stop(true)
    }
  })
}

function modelResponse(round: number, initialTool: string) {
  const name = round === 1 ? initialTool : 'read'
  const args =
    name === 'read'
      ? { path: round === 1 ? '/missing' : '/corrected' }
      : {
          path: '/missing',
          name: 'out.bin',
          mimeType: 'application/octet-stream',
        }
  const delta =
    round === 3
      ? { content: 'Corrected' }
      : {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `owned-call-${round}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        }
  return new Response(
    [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: round === 3 ? 'stop' : 'tool_calls' },
    ]
      .map(
        (chunk) =>
          `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, ...chunk }] })}\n\n`,
      )
      .join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

test('official command callbacks cannot prevent current-event accumulation', async () => {
  const quota = new Error('owned output quota')
  let received = 0
  let callbacks = 0
  let killBody: unknown
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/v2/sandboxes')
        return Response.json({
          sandboxID: 'owned-output',
          envdVersion: '0.6.2',
          envdAccessToken: 'fixture',
        })
      if (path === '/process.Process/Start')
        return new Response(
          Buffer.concat([
            connectFrame({ event: { start: { pid: 42 } } }),
            connectFrame({
              event: {
                data: {
                  stdout: Buffer.from('é'.repeat(65536)).toString('base64'),
                },
              },
            }),
            connectFrame({
              event: {
                data: {
                  stderr: Buffer.from('é'.repeat(65537)).toString('base64'),
                },
              },
            }),
            connectFrame({
              event: {
                data: {
                  stdout: Buffer.from('must not accumulate').toString('base64'),
                },
              },
            }),
            connectFrame({ event: { end: { exitCode: 0, exited: true } } }),
            connectFrame({}, 2),
          ]),
          { headers: { 'content-type': 'application/connect+json' } },
        )
      if (path === '/process.Process/SendSignal') {
        killBody = await request.json()
        return Response.json({})
      }
      return new Response('unexpected', { status: 500 })
    },
  })
  const endpoint = `http://127.0.0.1:${server.port}`
  const onOutput = (text: string) => {
    callbacks++
    received += Buffer.byteLength(text)
    if (received > 262144) throw quota
  }
  try {
    const client = new E2B({
      apiUrl: endpoint,
      sandboxUrl: endpoint,
      apiKey: 'fixture',
      retries: 0,
    })
    const remote = await client.Sandbox.create('fixture')
    const handle = await remote.commands.run('fixture', {
      background: true,
      onStdout: onOutput,
      onStderr: onOutput,
    })
    const outcome: unknown = await handle.wait().catch((error: unknown) => error)
    expect(outcome).toBeInstanceOf(Error)
    expect(String(outcome)).toContain('owned output quota')
    expect(callbacks).toBe(2)
    // RED for <= 262144 received 262146. The offending event is already
    // retained; throwing only prevents the later event from accumulating.
    expect(Buffer.byteLength(handle.stdout) + Buffer.byteLength(handle.stderr)).toBe(262146)
    expect(await handle.kill()).toBe(true)
    expect(killBody).toEqual({ process: { pid: 42 }, signal: 'SIGNAL_SIGKILL' })
  } finally {
    await server.stop(true)
  }
})

function connectFrame(value: unknown, flags = 0) {
  const payload = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

for (const text of ['', 'é'.repeat(131070) + '🙂']) {
  test(`bounded text read decodes complete UTF-8 after collection (${text.length} characters)`, async () => {
    const bytes = Buffer.from(text)
    const requests: string[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        requests.push(path)
        if (path === '/v2/sandboxes')
          return Response.json({
            sandboxID: 'owned-text',
            envdVersion: '0.6.2',
            envdAccessToken: 'fixture',
          })
        if (path === '/files')
          return new Response(
            new ReadableStream({
              start(controller) {
                // Split within a multibyte character, not at a text boundary.
                controller.enqueue(bytes.subarray(0, 1))
                controller.enqueue(bytes.subarray(1))
                controller.close()
              },
            }),
          )
        if (path.endsWith('/pause')) return new Response(null, { status: 204 })
        return new Response('unexpected', { status: 500 })
      },
    })
    const endpoint = `http://127.0.0.1:${server.port}`
    const signal = AbortSignal.timeout(5000)
    try {
      const session = await openE2BSandbox(
        {
          apiURL: endpoint,
          sandboxURL: endpoint,
          apiKey: 'fixture',
          template: 'fixture',
          timeoutMs: 120000,
          lease: {
            threadID: 'thread',
            runID: 'run',
            text: 'read',
            fence: 1,
            ownerID: 'fixture',
            history: [],
          },
        },
        signal,
      )
      expect(await session.read({ path: '/text', signal })).toBe(text)
      await session.close()
      expect(requests.at(-1)).toBe('/sandboxes/owned-text/pause')
    } finally {
      await server.stop(true)
    }
  })
}
