import { expect, spyOn, test } from 'bun:test'
import { S3Client } from '@aws-sdk/client-s3'
import { createClient } from 'redis'
import { executionStreams, type ExecutionCommand } from '@vid/contract/execution'
import {
  acceptCommandMessages,
  acceptCommands,
  initializeCommands,
} from '../../apps/agent/src/execution/commands'
import { acceptExecutionCommand } from '../../apps/agent/src/execution/db/command-acceptance'
import { bindExecutionWrites } from '../../apps/agent/src/execution/db/run-writes'
import { runWorker } from '../../apps/agent/src/execution/run-loop'
import { readWorkerEnv } from '@vid/config'
import { startWorker, WorkerProcess } from '../../apps/agent/src/worker'
import { serveWorkerHealth } from '../../apps/agent/src/worker-health'
import { observeEvents } from '../../apps/server/src/conversation/event-stream'
import { startServer } from '../../apps/server/src/server'
import * as receipts from '../../apps/server/src/conversation/execution-events'
import { serverTestEnv, storageSettings } from './authentication-fixture'
import { openTestDatabase, settleTestCleanup } from './database-fixture'
import { eventually, postgresProxy } from './postgres-proxy-fixture'

function env() {
  return readWorkerEnv({
    ...storageSettings,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    MODEL_BASE_URL: 'http://unused/v1',
    MODEL_API_KEY: 'private-model-key',
    MODEL_ID: 'unused',
    MODEL_CONTEXT_WINDOW: '8192',
    MODEL_MAX_OUTPUT_TOKENS: '1024',
    MODEL_PROMPT_PATH: '/unused',
    E2B_API_URL: 'http://unused',
    E2B_SANDBOX_URL: 'http://unused',
    E2B_API_KEY: 'private-vm-key',
    POLL_MS: '10',
  })
}
const noSpend = {
  harness: {
    run: async () => {
      throw new Error('Unexpected inference')
    },
  },
  openSandbox: async () => {
    throw new Error('Unexpected allocation')
  },
}

test('native empty intake and idle claims establish private readiness', async () => {
  const fixture = openTestDatabase()
  await fixture.db.selectFrom('execution.runs').select('run_id').limit(1).execute()
  await fixture.close()
  const worker = await startWorker(env(), noSpend)
  const other = await startWorker(env(), noSpend)
  const http = serveWorkerHealth(worker.health, 0)
  try {
    await eventually(() => worker.health().ready)
    const response = await fetch(`http://127.0.0.1:${http.port}/readyz`)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('ready')
    expect(body).not.toContain('private-model-key')
    expect(body).not.toContain('private-vm-key')
    await worker.stop()
    expect((await fetch(`http://127.0.0.1:${http.port}/livez`)).status).toBe(503)
    expect(other.health().live).toBe(true)
  } finally {
    await Promise.allSettled([worker.stop(), other.stop()])
    await http.stop(true)
  }
})

test('health remains available and unready while actual owned work joins stop', async () => {
  const worker = new WorkerProcess(env())
  const http = serveWorkerHealth(worker.health, 0)
  const held = Promise.withResolvers<void>()
  worker.own(held.promise)
  expect(worker.health().ready).toBe(false)
  const stopping = worker.stop()
  try {
    expect((await fetch(`http://127.0.0.1:${http.port}/readyz`)).status).toBe(503)
    expect(worker.health().live).toBe(false)
    held.resolve()
    await stopping
  } finally {
    held.resolve()
    await worker.stop()
    await http.stop(true)
  }
})

test('event receipt failure logs its explicit stage without inspecting rejected error fields', async () => {
  const privateCause = new Error('private payload')
  Object.defineProperty(privateCause, 'name', {
    get() {
      throw new Error('name inspected')
    },
  })
  Object.defineProperty(privateCause, 'message', {
    get() {
      throw new Error('message inspected')
    },
  })
  const consume = spyOn(receipts, 'consumeEventBatch').mockRejectedValue(privateCause)
  const rows: unknown[][] = []
  const log = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    rows.push(args)
  })
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    server = await startServer(serverTestEnv(), { port: 0 })
    const failure = await server.done.catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(rows).toContainEqual([
      'Server process failed',
      { stage: 'eventreceipt', rejectedType: 'object', isError: true },
    ])
    expect(JSON.stringify(rows)).not.toContain('private payload')
    if (!(failure instanceof AggregateError)) throw new Error('Expected aggregate')
    expect(failure.errors).toContain(privateCause)
  } finally {
    await server?.stop().catch(() => {})
    consume.mockRestore()
    log.mockRestore()
  }
})

test('public reconstruction reports authority stage without reading rejection fields', async () => {
  const fixture = openTestDatabase()
  const rows: unknown[][] = []
  const log = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    rows.push(args)
  })
  const cause = new Error('private authority')
  Object.defineProperty(cause, 'name', {
    get() {
      throw new Error('name inspected')
    },
  })
  try {
    const failure = await observeEvents(fixture.db, {
      ownerID: 'private-owner',
      threadID: 'private-thread',
      runID: 'private-run',
      after: '1',
      pollMs: 10,
      requestSignal: new AbortController().signal,
      processSignal: new AbortController().signal,
      authorize: async () => {
        throw cause
      },
    }).catch((error: unknown) => error)
    expect(failure).toBe(cause)
    expect(rows).toEqual([
      ['Public event read failed', { stage: 'authority', rejectedType: 'object', isError: true }],
    ])
  } finally {
    log.mockRestore()
    await fixture.close()
  }
})

test('public reconstruction distinguishes an actual unavailable database from authority failure', async () => {
  const fixture = openTestDatabase()
  await fixture.close()
  const rows: unknown[][] = []
  const log = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    rows.push(args)
  })
  try {
    const failure = await observeEvents(fixture.db, {
      ownerID: 'private-owner',
      threadID: 'private-thread',
      runID: 'private-run',
      after: '1',
      pollMs: 10,
      requestSignal: new AbortController().signal,
      processSignal: new AbortController().signal,
      authorize: async () => true,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(rows).toEqual([
      ['Public event read failed', { stage: 'read', rejectedType: 'object', isError: true }],
    ])
  } finally {
    log.mockRestore()
    await fixture.close()
  }
})

test('synchronous worker construction failure retains primary and storage cleanup rejection', async () => {
  const cleanup = new Error('controlled storage cleanup')
  const storage = spyOn(S3Client.prototype, 'destroy').mockImplementation(function (
    this: S3Client,
  ) {
    storage.mockRestore()
    this.destroy()
    throw cleanup
  })
  try {
    const failure = await startWorker(
      { ...env(), REDIS_URL: 'ftp://127.0.0.1:6379' },
      { harness: noSpend.harness },
    ).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('Expected both failures')
    expect(failure.errors[0]).toBeInstanceOf(Error)
    expect(failure.errors[1]).toBe(cleanup)
  } finally {
    storage.mockRestore()
  }
})

test('a blackholed native claim does not fabricate local completion progress and fail-stops its owner', async () => {
  const fixture = openTestDatabase()
  await fixture.db.selectFrom('execution.runs').select('run_id').limit(1).execute()
  await fixture.close()
  const proxy = await postgresProxy(env().DATABASE_URL)
  const worker = new WorkerProcess({
    ...env(),
    DATABASE_URL: proxy.databaseURL,
    IO_TIMEOUT_MS: 200,
  })
  const http = serveWorkerHealth(worker.health, 0)
  let pending: Promise<unknown> | undefined
  try {
    await worker.connect()
    expect(await worker.claim({ ownerID: crypto.randomUUID(), leaseMs: 1000 })).toBeNull()
    proxy.blackhole()
    const before = proxy.requests
    pending = worker.claim({ ownerID: crypto.randomUUID(), leaseMs: 1000 })
    worker.own(pending.then(() => {}))
    // Observe actual native request traffic, not a free-running health timer.
    await eventually(() => proxy.requests > before)
    expect(worker.health().ready).toBe(false)
    const failure = await worker.done.catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(worker.health().live).toBe(false)
    expect((await fetch(`http://127.0.0.1:${http.port}/readyz`)).status).toBe(503)
    await eventually(() => proxy.closedClients === proxy.connections)
    expect(proxy.closedClients).toBe(proxy.connections)
  } finally {
    await proxy.close()
    await pending?.catch(() => {})
    await worker.stop().catch(() => {})
    await http.stop(true)
  }
})

test('worker keeps owned failure and cleanup cause while closing both native Redis siblings', async () => {
  const primary = new Error('controlled task failure')
  const cleanup = new Error('controlled storage close')
  const objects = {
    read: async () => new Uint8Array(),
    put: async () => ({ byteLength: 0, sha256: '0'.repeat(64) }),
    close: () => {
      throw cleanup
    },
  }
  const worker = new WorkerProcess(env(), undefined, objects)
  try {
    await worker.connect()
    await worker.claim({ ownerID: crypto.randomUUID(), leaseMs: 1000 })
    worker.own(Promise.reject(primary))
    const failure = await worker.done.catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('Expected aggregate')
    expect(failure.errors).toContain(primary)
    expect(failure.errors).toContain(cleanup)
    expect(worker.commands.isOpen).toBe(false)
    expect(worker.blockingReader.isOpen).toBe(false)
    expect(await worker.stop().catch((cause: unknown) => cause)).toBe(failure)
  } finally {
    await worker.stop().catch(() => {})
  }
})

async function intakeFixture() {
  const url = process.env.VID_TEST_REDIS_TRANSPORT_URL
  const owner = process.env.VID_TEST_REDIS_OWNER
  if (!url || !owner || new URL(url).pathname !== '/15')
    throw new Error('Owned reserved transport database required')
  const fixture = openTestDatabase()
  const redis = createClient({ url, socket: { reconnectStrategy: false } })
  const threads: string[] = []
  const entries: string[] = []
  let admitted = false
  try {
    // Verify actual SQL ownership before any worker native call.
    await fixture.db.selectFrom('execution.runs').select('run_id').limit(1).execute()
    await redis.connect()
    if ((await redis.get('vid:test:owner')) !== owner)
      throw new Error('Owned reserved transport database required')
    admitted = true
    await initializeCommands(redis)
  } catch (cause) {
    if (redis.isOpen) redis.destroy()
    await fixture.close()
    throw cause
  }
  function command(start = false): ExecutionCommand {
    const threadID = crypto.randomUUID()
    threads.push(threadID)
    const identity = {
      version: 1 as const,
      commandID: crypto.randomUUID(),
      threadID,
      runID: crypto.randomUUID(),
    }
    return start
      ? {
          ...identity,
          kind: 'start',
          input: { messageID: crypto.randomUUID(), text: 'private-test-input' },
        }
      : { ...identity, kind: 'cancel' }
  }
  async function publish(body: ExecutionCommand) {
    const id = await redis.xAdd(executionStreams.commands, '*', {
      command: JSON.stringify(body),
    })
    entries.push(id)
    return id
  }
  async function read() {
    const streams = await redis.xReadGroup(
      executionStreams.commandGroup,
      crypto.randomUUID(),
      { key: executionStreams.commands, id: '>' },
      { COUNT: 32 },
    )
    return streams?.flatMap((stream) => stream.messages) ?? []
  }
  const close = () =>
    settleTestCleanup([
      async () => {
        if (admitted && entries.length) {
          await redis.xAck(executionStreams.commands, executionStreams.commandGroup, entries)
          await redis.xDel(executionStreams.commands, entries)
        }
      },
      async () => {
        if (!threads.length) return
        await fixture.db
          .updateTable('execution.conversations')
          .set({ active_run_id: null, lease_owner: null, lease_until: null })
          .where('thread_id', 'in', threads)
          .execute()
        await fixture.db
          .deleteFrom('execution.event_outbox')
          .where('thread_id', 'in', threads)
          .execute()
        await fixture.db.deleteFrom('execution.runs').where('thread_id', 'in', threads).execute()
        await fixture.db
          .deleteFrom('execution.command_inbox')
          .where('thread_id', 'in', threads)
          .execute()
        await fixture.db
          .deleteFrom('execution.conversations')
          .where('thread_id', 'in', threads)
          .execute()
      },
      async () => {
        if (redis.isOpen) redis.destroy()
      },
      fixture.close,
    ])
  return { ...fixture, redis, url, command, publish, read, close }
}

test('durable acceptance precedes ACK failure and stop preserves the exact remaining PEL', async () => {
  const f = await intakeFixture()
  const first = f.command()
  const second = f.command()
  try {
    await f.publish(first)
    const secondID = await f.publish(second)
    const messages = await f.read()
    const unopened = createClient()
    const ackFailure = await acceptCommandMessages(f.db, unopened, messages).catch(
      (cause: unknown) => cause,
    )
    expect(ackFailure).toBeInstanceOf(Error)
    expect(await acceptExecutionCommand(f.db, first)).toBe('replay')
    expect(
      (await f.redis.xPending(executionStreams.commands, executionStreams.commandGroup)).pending,
    ).toBe(2)
    const count = await acceptCommandMessages(f.db, f.redis, messages.slice(0, 1))
    expect(count).toBe(1)
    const stopped = AbortSignal.abort()
    expect(
      await acceptCommandMessages(f.db, f.redis, messages.slice(1), {
        signal: stopped,
      }),
    ).toBe(0)
    expect(
      (
        await f.redis.xPendingRange(
          executionStreams.commands,
          executionStreams.commandGroup,
          '-',
          '+',
          10,
        )
      ).map((entry) => entry.id),
    ).toEqual([secondID])
    expect(
      await f.db
        .selectFrom('execution.command_inbox')
        .select('command_id')
        .where('command_id', '=', second.commandID)
        .executeTakeFirst(),
    ).toBeUndefined()
  } finally {
    await f.close()
  }
})

test('real saturated long harness remains ready while native SQL renews and stop owns deletion', async () => {
  const f = await intakeFixture()
  const worker = new WorkerProcess({
    ...env(),
    REDIS_URL: f.url,
    IO_TIMEOUT_MS: 100,
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const http = serveWorkerHealth(worker.health, 0)
  try {
    await worker.connect()
    worker.markReady()
    const command = f.command(true)
    await acceptExecutionCommand(f.db, command)
    worker.own(
      acceptCommands(
        worker.db,
        {
          commands: worker.commands,
          blockingReader: worker.blockingReader,
          consumerID: crypto.randomUUID(),
        },
        worker.signal,
      ),
    )
    worker.own(
      runWorker(
        {
          claim: worker.claim,
          writes: bindExecutionWrites(worker.db),
          harness: {
            run: async ({ signal }) => {
              entered.resolve()
              await release.promise
              signal.throwIfAborted()
              return { text: '' }
            },
          },
          openSandbox: async () => ({
            nativeRef: { provider: 'e2b', id: 'private-native-id' },

            readBytes: async () => new Uint8Array(),
            writeBytes: async () => {},
            execute: async () => {
              throw new Error('Unused')
            },
            read: async () => '',
            write: async () => {},
            close: async () => {},
          }),
        },
        {
          ownerID: crypto.randomUUID(),
          concurrency: 1,
          leaseMs: 1000,
          pollMs: 10,
          signal: worker.signal,
        },
      ),
    )
    await entered.promise
    const initial = await f.db
      .selectFrom('execution.conversations')
      .select('lease_until')
      .where('thread_id', '=', command.threadID)
      .executeTakeFirstOrThrow()
    // Wait past the idle observation budget, then inspect real native renewal.
    await Bun.sleep(250)
    const current = await f.db
      .selectFrom('execution.conversations')
      .select('lease_until')
      .where('thread_id', '=', command.threadID)
      .executeTakeFirstOrThrow()
    expect(current.lease_until!.getTime()).toBeGreaterThan(initial.lease_until!.getTime())
    await eventually(() => worker.health().ready)
    const response = await fetch(`http://127.0.0.1:${http.port}/readyz`)
    expect(response.status).toBe(200)
    const body = await response.text()
    for (const privateValue of [
      command.threadID,
      command.runID,
      'private-native-id',
      'private-test-input',
    ])
      expect(body).not.toContain(privateValue)
    const stopping = worker.stop()
    expect(worker.health().ready).toBe(false)
    release.resolve()
    await stopping
  } finally {
    release.resolve()
    await worker.stop().catch(() => {})
    await http.stop(true)
    await f.close()
  }
})
