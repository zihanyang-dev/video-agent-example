import { expect, test } from 'bun:test'
import { readWorkerEnv, readMigrationEnv } from '@vid/config'
import { executionStreams } from '@vid/contract/execution'
import { createClient } from 'redis'
import { sql } from 'kysely'
import {
  executeRun,
  type ExecutionLease,
  type RunSandbox,
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
    MODEL_PROMPT_PATH: new URL(
      '../../profiles/video/instructions.md',
      import.meta.url,
    ).pathname,
    EGRESS_URL: 'http://unused',
    E2B_API_URL: 'http://unused',
    E2B_SANDBOX_URL: 'http://unused',
    E2B_API_KEY: 'test',
    TURN_TOKEN_SECRET: 'x'.repeat(32),
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
    renewTimeout: async () => {},
    files: {
      readBytes: async () => new Uint8Array(),
      writeBytes: async () => {},
    },
    tools: {
      execute: async () => {
        throw new Error('unexpected tool')
      },
      read: async () => {
        throw new Error('unexpected tool')
      },
      write: async () => {
        throw new Error('unexpected tool')
      },
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
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
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
  try {
    const id = await commands.xAdd(executionStreams.commands, '*', {
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
    const replacement = await startWorker(workerEnv(), noExternalExecution)
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
    await commands.xAck(
      executionStreams.commands,
      executionStreams.commandGroup,
      id,
    )
    await commands.xDel(executionStreams.commands, id)
  } finally {
    await worker.stop().catch(() => {})
    commands.destroy()
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
    remove: async () => {},
    list: async () => ({ objects: [], continuationToken: undefined }),
    close: () => {
      closed = true
    },
  }
  const worker = new WorkerProcess(env, undefined, objects)
  worker.own(settlement)
  const stopping = worker.stop()
  await Bun.sleep(10)
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
    remove: async () => {
      throw new Error('Uncertain uploads must not be deleted')
    },
    list: async () => ({ objects: [], continuationToken: undefined }),
    close: () => {
      closed = true
    },
  }
  const worker = new WorkerProcess(workerEnv(), undefined, objects)
  const lease: ExecutionLease = {
    threadID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    commandID: crypto.randomUUID(),
    messageID: crypto.randomUUID(),
    text: 'export',
    history: [],
    fence: 1,
    ownerID: 'test',
  }
  const assigned: RunSandbox = {
    nativeRef: { provider: 'e2b', id: 'known-native' },
    renewTimeout: async () => {},
    files: {
      readBytes: async () => new Uint8Array([0, 255]),
      writeBytes: async () => {},
    },
    tools: sandbox(async () => {}).tools,
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
