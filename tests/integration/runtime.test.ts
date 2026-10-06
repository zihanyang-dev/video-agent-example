import { expect, spyOn, test } from 'bun:test'
import { S3Client } from '@aws-sdk/client-s3'
import { createServer, type Socket } from 'node:net'
import * as objectStorage from '@vid/object-storage'
import { readWorkerEnv, readMigrationEnv } from '@vid/config'
import { executionStreams } from '@vid/contract/execution'
import { createClient } from 'redis'
import { sql } from 'kysely'
import {
  executeRun,
  type ExecutionLease,
  type SandboxSessionPort,
} from '../../apps/agent/src/execute-run'
import { assignFileTools } from '../../apps/agent/src/harness/files'
import { createPiHarness } from '../../apps/agent/src/harness/pi'
import { WorkerProcess } from '../../apps/agent/src/worker'
import { startServer } from '../../apps/server/src/server'
import { startWorker } from '../../apps/agent/src/worker'
import {
  signedTestIdentity,
  serverTestEnv,
  storageSettings,
} from './authentication-fixture'
import { openTestDatabase } from './database-fixture'
import { postgresProxy, eventually } from './postgres-proxy-fixture'

function workerEnv(baseURL = 'http://unused/v1') {
  return readWorkerEnv({
    ...storageSettings,
    DATABASE_URL: readMigrationEnv().DATABASE_URL,
    REDIS_URL: serverTestEnv().REDIS_URL,
    MODEL_BASE_URL: baseURL,
    MODEL_API_KEY: 'test',
    MODEL_ID: 'local',
    MODEL_CONTEXT_WINDOW: '8192',
    MODEL_MAX_OUTPUT_TOKENS: '1024',
    MODEL_PROMPT_PATH: new URL('../../apps/agent/prompt.md', import.meta.url)
      .pathname,
    E2B_API_URL: 'http://unused',
    E2B_SANDBOX_URL: 'http://unused',
    E2B_API_KEY: 'test',
    POLL_MS: '10',
  })
}
function localModel() {
  const requests: unknown[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe('Bearer test')
      requests.push(await request.json())
      const chunks = [
        {
          delta: { role: 'assistant', content: 'reply: hello' },
          finish_reason: null,
        },
        { delta: {}, finish_reason: 'stop' },
      ]
      return new Response(
        chunks
          .map(
            (chunk) =>
              `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, ...chunk }] })}\n\n`,
          )
          .join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  return { server, requests, baseURL: `http://127.0.0.1:${server.port}/v1` }
}
function sandbox(close: () => Promise<void>) {
  return {
    nativeRef: { provider: 'e2b', id: 'fixture-native' },
    readBytes: async () => new Uint8Array(),
    writeBytes: async () => {},
    execute: async () => {
      throw new Error('unexpected tool')
    },
    read: async () => {
      throw new Error('unexpected tool')
    },
    write: async () => {
      throw new Error('unexpected tool')
    },
    close,
  }
}
const identities = new Map<string, Headers>()
async function submit(url: string) {
  const { db, close } = openTestDatabase()
  const login = await signedTestIdentity(db)
  await close()
  const headers = login.headers
  const response = await fetch(`${url}/api/threads`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      threadID: crypto.randomUUID(),
      title: 'Runtime chat',
    }),
  })
  const {
    thread: { threadID },
  } = (await response.json()) as { thread: { threadID: string } }
  identities.set(threadID, headers)
  const submitted = await fetch(`${url}/api/threads/${threadID}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ messageID: crypto.randomUUID(), text: 'hello' }),
  })
  expect(submitted.status).toBe(202)
  return threadID
}
async function answer(url: string, threadID: string) {
  const deadline = performance.now() + 5000
  while (performance.now() < deadline) {
    const result = await (
      await fetch(`${url}/api/threads/${threadID}/messages`, {
        headers: identities.get(threadID)!,
      })
    ).text()
    if (result.includes('reply: hello')) return result
    await Bun.sleep(20)
  }
  throw new Error('No stored answer')
}

test('server releases every allocated object store when native client construction fails', async () => {
  const created: objectStorage.ObjectStore[] = []
  const released = new Set<objectStorage.ObjectStore>()
  const closes: ReturnType<typeof spyOn>[] = []
  const nativeConnect = objectStorage.connectObjects
  const connect = spyOn(objectStorage, 'connectObjects').mockImplementation(
    (options) => {
      const store = nativeConnect(options)
      const nativeClose = store.close.bind(store)
      created.push(store)
      closes.push(
        spyOn(store, 'close').mockImplementation(() => {
          nativeClose()
          released.add(store)
        }),
      )
      return store
    },
  )
  try {
    const failure = await startServer(
      { ...serverTestEnv(), REDIS_URL: 'ftp://127.0.0.1:6379' },
      { port: 0 },
    ).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(Error)
    expect(created).toHaveLength(1)
    expect([...released]).toEqual(created)
  } finally {
    connect.mockRestore()
    for (const close of closes) close.mockRestore()
    for (const store of created.filter((store) => !released.has(store)))
      store.close()
  }
})

test('server closes its PostgreSQL sockets even when native storage close throws', async () => {
  const env = serverTestEnv()
  const proxy = await postgresProxy(env.DATABASE_URL)
  const server = await startServer(
    { ...env, DATABASE_URL: proxy.databaseURL },
    { port: 0 },
  )
  const cleanupFailure = new Error('Injected native storage close failure')
  const storageClose = spyOn(S3Client.prototype, 'destroy')
  storageClose.mockImplementation(function (this: S3Client) {
    storageClose.mockRestore()
    this.destroy()
    throw cleanupFailure
  })
  try {
    expect((await fetch(`${server.url}/api/session`)).status).toBe(200)
    expect(proxy.connections).toBeGreaterThan(0)
    const failure = await server.stop().catch((cause: unknown) => cause)
    await eventually(() => proxy.closedClients === proxy.connections, 500)
    expect(proxy.closedClients).toBe(proxy.connections)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError))
      throw new Error('Expected cleanup failure')
    expect(failure.errors).toContain(cleanupFailure)
    expect(await server.stop().catch((cause: unknown) => cause)).toBe(failure)
  } finally {
    storageClose.mockRestore()
    await proxy.close()
    await server.stop().catch(() => {})
  }
})

test('server startup retains the connection failure when cleanup also fails', async () => {
  const cleanupFailure = new Error('Injected native storage close failure')
  const storageClose = spyOn(S3Client.prototype, 'destroy')
  storageClose.mockImplementation(function (this: S3Client) {
    storageClose.mockRestore()
    this.destroy()
    throw cleanupFailure
  })
  try {
    const failure = await startServer(
      { ...serverTestEnv(), REDIS_URL: 'redis://127.0.0.1:1' },
      { port: 0 },
    ).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError))
      throw new Error('Expected startup failure')
    const primary: unknown = failure.errors[0]
    expect(primary).toBeInstanceOf(Error)
    expect(String(primary)).toContain('ECONNREFUSED')
    const cleanup: unknown = failure.errors[1]
    expect(cleanup).toBeInstanceOf(AggregateError)
    if (!(cleanup instanceof AggregateError))
      throw new Error('Expected cleanup failure')
    expect(cleanup.errors).toContain(cleanupFailure)
  } finally {
    storageClose.mockRestore()
  }
})

test('server joins both native Redis initializations when TCP accepts but protocol initialization stalls', async () => {
  const sockets = new Set<Socket>()
  let accepted = 0
  const tcp = createServer((socket) => {
    accepted += 1
    sockets.add(socket)
    socket.on('data', () => {})
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
  const address = tcp.address()
  if (address === null || typeof address === 'string')
    throw new Error('Expected native TCP listener')
  let settled = false
  const result = startServer(
    {
      ...serverTestEnv(),
      IO_TIMEOUT_MS: 1000,
      REDIS_URL: `redis://127.0.0.1:${address.port}`,
    },
    { port: 0 },
  )
    .then(
      () => {
        throw new Error('Silent Redis unexpectedly initialized')
      },
      (cause: unknown) => cause,
    )
    .finally(() => {
      settled = true
    })
  try {
    await eventually(() => settled, 3000)
    expect(settled).toBe(true)
    expect(await result).toBeInstanceOf(Error)
    await eventually(() => sockets.size === 0, 500)
    expect(accepted).toBe(2)
    expect(sockets.size).toBe(0)
  } finally {
    for (const socket of sockets) socket.destroy()
    await result
    await new Promise<void>((resolve, reject) =>
      tcp.close((cause) => (cause ? reject(cause) : resolve())),
    )
  }
})

test('server caps owned file work without blocking ordinary reads and releases admission after completion', async () => {
  const { db, close } = openTestDatabase()
  const login = await signedTestIdentity(db)
  const server = await startServer(serverTestEnv(), { port: 0 })
  let unlock = () => {}
  let locked = () => {}
  const entered = new Promise<void>((resolve) => {
    locked = resolve
  })
  const held = new Promise<void>((resolve) => {
    unlock = resolve
  })
  const locking = db.transaction().execute(async (tx) => {
    await sql`LOCK TABLE product.assets IN ACCESS EXCLUSIVE MODE`.execute(tx)
    locked()
    await held
  })
  const requests: Promise<Response>[] = []
  const file = () =>
    fetch(`${server.url}/api/assets/${crypto.randomUUID()}/file`, {
      headers: login.headers,
    })
  try {
    await entered
    requests.push(...Array.from({ length: 4 }, file))
    let blocked = 0
    const deadline = performance.now() + 2000
    while (blocked !== 4 && performance.now() < deadline) {
      const observed = await sql<{
        count: string
      }>`SELECT count(*)::text AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE ${'%"product"."assets"%'}`.execute(
        db,
      )
      blocked = Number(observed.rows[0]?.count)
      await Bun.sleep(10)
    }
    expect(blocked).toBe(4)
    expect((await file()).status).toBe(429)
    expect(
      (await fetch(`${server.url}/api/session`, { headers: login.headers }))
        .status,
    ).toBe(200)
    unlock()
    await locking
    expect(
      (await Promise.all(requests)).map((response) => response.status),
    ).toEqual([404, 404, 404, 404])
    expect((await file()).status).toBe(404)
  } finally {
    unlock()
    await locking
    await Promise.allSettled(requests)
    await Promise.allSettled([server.stop(), close()])
  }
})

test('unsupported inherited MIME headers are rejected without stopping HTTP', async () => {
  const { db, close } = openTestDatabase()
  const login = await signedTestIdentity(db)
  const server = await startServer(serverTestEnv(), { port: 0 })
  try {
    const threadID = crypto.randomUUID()
    expect(
      (
        await fetch(`${server.url}/api/threads`, {
          method: 'POST',
          headers: login.headers,
          body: JSON.stringify({ threadID, title: 'MIME boundary' }),
        })
      ).status,
    ).toBe(201)
    for (const mimeType of ['constructor', 'toString', '__proto__']) {
      const headers = new Headers(login.headers)
      headers.set('content-type', mimeType)
      headers.set('x-asset-id', crypto.randomUUID())
      headers.set('x-file-name', 'note.txt')
      expect(
        (
          await fetch(`${server.url}/api/threads/${threadID}/assets`, {
            method: 'POST',
            headers,
            body: 'hello',
          })
        ).status,
      ).toBe(415)
      expect(
        (await fetch(`${server.url}/api/session`, { headers: login.headers }))
          .status,
      ).toBe(200)
    }
    expect(
      await db
        .selectFrom('product.assets')
        .select('asset_id')
        .where('thread_id', '=', threadID)
        .execute(),
    ).toEqual([])
  } finally {
    await server.stop()
    await close()
  }
})

test.each(['hello\u0000world', '\ud800', '\udc00'])(
  'unrepresentable input %j is rejected before PostgreSQL without stopping HTTP',
  async (text) => {
    const { db, close } = openTestDatabase()
    const login = await signedTestIdentity(db)
    const server = await startServer(serverTestEnv(), { port: 0 })
    const threadID = crypto.randomUUID()
    const rejectedThreadID = crypto.randomUUID()
    const messageID = crypto.randomUUID()
    try {
      expect(
        (
          await fetch(`${server.url}/api/threads`, {
            method: 'POST',
            headers: login.headers,
            body: JSON.stringify({ threadID, title: 'Original title' }),
          })
        ).status,
      ).toBe(201)
      for (const [path, method, input] of [
        [`/api/threads/${threadID}/messages`, 'POST', { messageID, text }],
        ['/api/threads', 'POST', { threadID: rejectedThreadID, title: text }],
        [`/api/threads/${threadID}`, 'PATCH', { title: text }],
      ] as const) {
        const response = await fetch(`${server.url}${path}`, {
          method,
          headers: login.headers,
          body: JSON.stringify(input),
        })
        expect(response.status).toBe(400)
        expect(
          (await fetch(`${server.url}/api/session`, { headers: login.headers }))
            .status,
        ).toBe(200)
      }
      expect(
        await db
          .selectFrom('product.threads')
          .select('thread_id')
          .where('thread_id', '=', rejectedThreadID)
          .execute(),
      ).toEqual([])
      expect(
        (
          await db
            .selectFrom('product.threads')
            .select('title')
            .where('thread_id', '=', threadID)
            .executeTakeFirstOrThrow()
        ).title,
      ).toBe('Original title')
      expect(
        await db
          .selectFrom('product.messages')
          .select('message_id')
          .where('thread_id', '=', threadID)
          .execute(),
      ).toEqual([])
      expect(
        await db
          .selectFrom('product.command_outbox')
          .select('command_id')
          .where('thread_id', '=', threadID)
          .execute(),
      ).toEqual([])
    } finally {
      await server.stop().catch(() => {})
      await close()
    }
  },
)

// Fresh database/Redis from scripts/database-check.sh; real Pi, no cloud or VM.
test('HTTP -> command -> leased Pi -> private history -> event -> stored public answer', async () => {
  const model = localModel()
  const server = await startServer(serverTestEnv(), { port: 0 })
  let closed = 0
  const modelEnv = workerEnv(model.baseURL)
  const harness = createPiHarness({
    baseURL: modelEnv.MODEL_BASE_URL,
    key: modelEnv.MODEL_API_KEY,
    modelID: modelEnv.MODEL_ID,
    contextWindow: modelEnv.MODEL_CONTEXT_WINDOW,
    maxOutputTokens: modelEnv.MODEL_MAX_OUTPUT_TOKENS,
    reasoning: modelEnv.MODEL_REASONING,
    input: ['text'],
    systemPrompt: await Bun.file(modelEnv.MODEL_PROMPT_PATH).text(),
  })
  const worker = await startWorker(modelEnv, {
    harness,
    openSandbox: async () =>
      sandbox(async () => {
        closed++
      }),
  })
  const { db, close } = openTestDatabase()
  try {
    const threadID = await submit(server.url)
    const result = await answer(server.url, threadID)
    expect(result).not.toContain('header')
    const execution = await db
      .selectFrom('execution.conversations')
      .select(['history', 'active_run_id'])
      .where('thread_id', '=', threadID)
      .executeTakeFirstOrThrow()
    expect(execution.history).toHaveProperty('entries')
    expect(execution.active_run_id).toBeNull()
    expect(closed).toBe(1)
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]).toHaveProperty(
      'messages.0.content',
      expect.stringContaining(
        (await Bun.file(workerEnv().MODEL_PROMPT_PATH).text()).trim(),
      ),
    )
  } finally {
    await Promise.all([worker.stop(), server.stop()])
    await model.server.stop(true)
    await close()
  }
}, 15000)

// Poison intake must never acquire either external spending capability.
const noExternalExecution = {
  harness: {
    turn: async () => {
      throw new Error('Unexpected turn')
    },
  },
  openSandbox: async () => {
    throw new Error('Unexpected sandbox')
  },
}

test('poison delivery fails the owning process and remains pending, without ACK or hot-loop', async () => {
  const commands = createClient({
    url: serverTestEnv().REDIS_URL,
    socket: { reconnectStrategy: false },
  })
  commands.on('error', () => {})
  await commands.connect()
  const worker = await startWorker(workerEnv(), noExternalExecution)
  let replacement: Awaited<ReturnType<typeof startWorker>> | undefined
  let id: string | undefined
  try {
    id = await commands.xAdd(executionStreams.commands, '*', {
      command: '{invalid',
    })
    const failure = await worker.done.then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(AggregateError)
    expect(String(failure)).toContain('unaccepted deliveries remain pending')
    const pending = await commands.xPendingRange(
      executionStreams.commands,
      executionStreams.commandGroup,
      id,
      id,
      1,
    )
    expect(pending).toHaveLength(1)
    expect(pending[0]?.deliveriesCounter).toBe(1)
    await Bun.sleep(1100)
    replacement = await startWorker(workerEnv(), noExternalExecution)
    const recoveredFailure = await replacement.done.then(
      () => null,
      (error: unknown) => error,
    )
    expect(recoveredFailure).toBeInstanceOf(AggregateError)
    const recovered = await commands.xPendingRange(
      executionStreams.commands,
      executionStreams.commandGroup,
      id,
      id,
      1,
    )
    expect(recovered[0]?.deliveriesCounter).toBe(2)
  } finally {
    await Promise.allSettled([
      worker.stop(),
      ...(replacement ? [replacement.stop()] : []),
    ])
    const poisonID = id
    const removed =
      poisonID === undefined
        ? Promise.resolve()
        : commands
            .xAck(
              executionStreams.commands,
              executionStreams.commandGroup,
              poisonID,
            )
            .then(() => commands.xDel(executionStreams.commands, poisonID))
    await removed.finally(() => {
      if (commands.isOpen) commands.destroy()
    })
  }
}, 15000)

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

test('worker shutdown aborts inference and awaits sandbox cleanup before closing DB', async () => {
  const started = gate()
  const cleanup = gate()
  const release = gate()
  const server = await startServer(serverTestEnv(), { port: 0 })
  const worker = await startWorker(
    { ...workerEnv(), MODEL_PROMPT_PATH: '/missing/test-profile.md' },
    {
      harness: {
        async turn({ signal }) {
          started.release()
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
            if (signal.aborted) resolve()
          })
          signal.throwIfAborted()
          throw new Error('Expected abort')
        },
      },
      openSandbox: async () =>
        sandbox(async () => {
          cleanup.release()
          await release.promise
        }),
    },
  )
  const { db, close } = openTestDatabase()
  try {
    const threadID = await submit(server.url)
    await started.promise
    let stopped = false
    const stopping = worker.stop().then(() => {
      stopped = true
    })
    await cleanup.promise
    expect(stopped).toBe(false)
    const leased = await db
      .selectFrom('execution.conversations')
      .select('active_run_id')
      .where('thread_id', '=', threadID)
      .executeTakeFirstOrThrow()
    expect(leased.active_run_id).not.toBeNull()
    release.release()
    await stopping
    const run = await db
      .selectFrom('execution.runs')
      .select('status')
      .where('thread_id', '=', threadID)
      .executeTakeFirstOrThrow()
    expect(run.status).toBe('failed')
  } finally {
    release.release()
    await worker.stop()
    await server.stop()
    await close()
  }
}, 15000)

test('missing trusted model profile rejects startup before consuming commands', async () => {
  const failure = await startWorker(
    {
      ...workerEnv(),
      MODEL_PROMPT_PATH: '/missing/video-instructions.md',
    },
    {},
  ).then(
    async (worker) => {
      await worker.stop()
      return null
    },
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(Error)
  expect(String(failure)).toContain('/missing/video-instructions.md')
})

test('worker process waits for SQL cancellation before disconnecting and reports failure to all stoppers', async () => {
  const worker = new WorkerProcess({ ...workerEnv(), IO_TIMEOUT_MS: 1000 })
  await worker.connect()
  const querying = sql`select pg_sleep(10)`.execute(worker.db).then(() => {})
  worker.own(querying)
  const first = worker.stop().then(
    () => null,
    (error: unknown) => error,
  )
  const second = worker.stop().then(
    () => null,
    (error: unknown) => error,
  )
  const [firstFailure, secondFailure] = await Promise.all([first, second])
  expect(firstFailure).toBeInstanceOf(AggregateError)
  expect(secondFailure).toBeInstanceOf(AggregateError)
  if (!(firstFailure instanceof AggregateError))
    throw new Error('Expected SQL failure')
  expect(firstFailure.errors.map(String).join(' ')).toContain(
    'statement timeout',
  )
})

test('established PostgreSQL response blackhole settles owned SQL and worker shutdown, closing the physical socket', async () => {
  const env = workerEnv()
  const proxy = await postgresProxy(env.DATABASE_URL)
  let storageClosed = false
  const objects = {
    read: async () => new Uint8Array(),
    put: async () => ({ byteLength: 0, sha256: '0'.repeat(64) }),
    close: () => {
      storageClosed = true
    },
  }
  const worker = new WorkerProcess(
    { ...env, DATABASE_URL: proxy.databaseURL, IO_TIMEOUT_MS: 300 },
    undefined,
    objects,
  )
  let failure: unknown
  let settled = false
  let stopping: Promise<void> | undefined
  try {
    await worker.connect()
    await sql`select 1`.execute(worker.db)
    expect(proxy.connections).toBe(1)
    proxy.blackhole()
    const before = proxy.requests
    const querying = sql`select 2`.execute(worker.db).then(() => {})
    worker.own(querying)
    await eventually(() => proxy.requests > before)
    expect(proxy.requests).toBeGreaterThan(before)
    const started = performance.now()
    stopping = worker
      .stop()
      .catch((error: unknown) => {
        failure = error
      })
      .finally(() => {
        settled = true
      })
    await eventually(() => settled, 1500)
    expect(settled).toBe(true)
    expect(performance.now() - started).toBeLessThan(1500)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(storageClosed).toBe(true)
    expect(worker.commands.isOpen).toBe(false)
    expect(worker.blockingReader.isOpen).toBe(false)
    await eventually(() => proxy.closedClients === 1)
    expect(proxy.closedClients).toBe(1)
  } finally {
    // RED cleanup closes only this fixture's sockets, then awaits the real owner.
    await proxy.close()
    await stopping
    await worker.stop().catch(() => {})
  }
}, 10000)

test('server process settles HTTP and background SQL after an established PostgreSQL response blackhole', async () => {
  const env = serverTestEnv()
  const proxy = await postgresProxy(env.DATABASE_URL)
  const identity = openTestDatabase()
  const login = await signedTestIdentity(identity.db)
  await identity.close()
  const server = await startServer(
    { ...env, DATABASE_URL: proxy.databaseURL, IO_TIMEOUT_MS: 300 },
    { port: 0 },
  )
  let settled = false
  let failure: unknown
  let stopping: Promise<void> | undefined
  let request: Promise<Response | undefined> | undefined
  try {
    const warm = await fetch(`${server.url}/api/session`, {
      headers: login.headers,
    })
    expect(warm.status).toBe(200)
    expect(proxy.connections).toBeGreaterThan(0)
    proxy.blackhole()
    const before = proxy.requests
    request = fetch(`${server.url}/api/session`, {
      headers: login.headers,
    }).catch(() => undefined)
    await eventually(() => proxy.requests > before)
    expect(proxy.requests).toBeGreaterThan(before)
    const started = performance.now()
    stopping = server
      .stop()
      .catch((error: unknown) => {
        failure = error
      })
      .finally(() => {
        settled = true
      })
    await eventually(() => settled, 1500)
    expect(settled).toBe(true)
    expect(performance.now() - started).toBeLessThan(1500)
    expect(failure).toBeInstanceOf(AggregateError)
    await eventually(() => proxy.closedClients === proxy.connections)
    expect(proxy.closedClients).toBe(proxy.connections)
  } finally {
    await proxy.close()
    await stopping
    await request
    await server.stop().catch(() => {})
  }
}, 10000)

test('blackholed worker database stops an active turn and settles pause without allocation or inference replay', async () => {
  const env = workerEnv()
  const proxy = await postgresProxy(env.DATABASE_URL)
  const server = await startServer(serverTestEnv(), { port: 0 })
  let turns = 0
  let allocations = 0
  let pauses = 0
  let aborted = false
  const worker = await startWorker(
    {
      ...env,
      DATABASE_URL: proxy.databaseURL,
      IO_TIMEOUT_MS: 300,
      CONCURRENCY: 1,
    },
    {
      harness: {
        async turn({ signal }) {
          turns++
          proxy.blackhole()
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
            if (signal.aborted) resolve()
          })
          aborted = true
          signal.throwIfAborted()
          throw new Error('Expected abort')
        },
      },
      openSandbox: async () => {
        allocations++
        return sandbox(async () => {
          pauses++
        })
      },
    },
  )
  let settled = false
  let failure: unknown
  const done = worker.done
    .catch((error: unknown) => {
      failure = error
    })
    .finally(() => {
      settled = true
    })
  try {
    const threadID = await submit(server.url)
    // A pre-turn failure must still reach finally and settle both processes.
    await eventually(() => turns > 0 || settled, 3000)
    expect(turns).toBe(1)
    const started = performance.now()
    await eventually(() => settled, 3000)
    expect(settled).toBe(true)
    expect(performance.now() - started).toBeLessThan(3000)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(aborted).toBe(true)
    expect(pauses).toBe(1)
    expect(turns).toBe(1)
    expect(allocations).toBe(1)
    await eventually(() => proxy.closedClients === proxy.connections)
    expect(proxy.closedClients).toBe(proxy.connections)
    proxy.restore()
    await Bun.sleep(50)
    expect(turns).toBe(1)
    const observer = openTestDatabase()
    try {
      const run = await observer.db
        .selectFrom('execution.runs')
        .select('status')
        .where('thread_id', '=', threadID)
        .executeTakeFirstOrThrow()
      expect(run.status).not.toBe('completed')
    } finally {
      await observer.close()
    }
    await worker.stop().catch(() => {})
  } finally {
    await proxy.close()
    await worker.stop().catch(() => {})
    await done
    await server.stop()
  }
}, 15000)

test('worker storage closes only after an owned slow tool/pause task settles, including startup failure', async () => {
  const env = workerEnv()
  let released!: () => void
  const settlement = new Promise<void>((resolve) => {
    released = resolve
  })
  let closed = false
  const objects = {
    read: async () => new Uint8Array(),
    put: async () => ({ byteLength: 0, sha256: '0'.repeat(64) }),
    close: () => {
      closed = true
    },
  }
  const worker = new WorkerProcess(env, undefined, objects)
  worker.own(settlement)
  const stopping = worker.stop()
  expect(closed).toBe(false)
  released()
  await stopping
  expect(closed).toBe(true)
  closed = false
  const stopped = new WorkerProcess(env, AbortSignal.abort(), objects)
  await Promise.resolve(expect(stopped.connect()).rejects.toThrow())
  await stopped.stop()
  expect(closed).toBe(true)
})

test('process S3 closes after actual slow file export and native pause settlement', async () => {
  const uploading = gate()
  const uploaded = gate()
  const pausing = gate()
  const paused = gate()
  let closed = false
  let retainedBytes = 0
  const objects = {
    read: async () => new Uint8Array(),
    put: async (_key: string, bytes: Uint8Array) => {
      uploading.release()
      await uploaded.promise
      retainedBytes = bytes.byteLength
      return { byteLength: bytes.byteLength, sha256: '0'.repeat(64) }
    },
    close: () => {
      closed = true
    },
  }
  const worker = new WorkerProcess(workerEnv(), undefined, objects)
  const lease: ExecutionLease = {
    threadID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    text: 'export',
    history: [],
    fence: 1,
    ownerID: 'test',
  }
  const assigned: SandboxSessionPort = {
    nativeRef: { provider: 'e2b', id: 'known-native' },
    readBytes: async () => new Uint8Array([0, 255]),
    writeBytes: async () => {},
    execute: sandbox(async () => {}).execute,
    read: sandbox(async () => {}).read,
    write: sandbox(async () => {}).write,
    close: async () => {
      pausing.release()
      await paused.promise
    },
  }
  const execution = executeRun(
    lease,
    {
      writes: {
        saveSandbox: async () => true,
        quarantine: async () => {},
        renew: async () => 'renewed',
        appendText: async () => true,
        complete: async () => true,
        fail: async () => true,
        cancel: async () => true,
      },
      openSandbox: async () => assigned,
      fileTools: assignFileTools(objects, {
        maxBytes: 8,
        maxFiles: 2,
        timeoutMs: 5000,
      }),
      harness: {
        turn: async ({ fileTools, signal }) => {
          if (!fileTools) throw new Error('Missing assigned file tools')
          await fileTools.exportFile({
            path: '/chosen',
            name: 'file.bin',
            mimeType: 'application/octet-stream',
            signal,
          })
          signal.throwIfAborted()
          return { text: 'done', history: [] }
        },
      },
    },
    { signal: worker.signal, leaseMs: 1000, pollMs: 10 },
  )
  worker.own(execution.then(() => {}))
  await uploading.promise
  const stopping = worker.stop()
  expect(closed).toBe(false)
  uploaded.release()
  await pausing.promise
  expect(closed).toBe(false)
  paused.release()
  await stopping
  expect(closed).toBe(true)
  expect(retainedBytes).toBe(2)
})
