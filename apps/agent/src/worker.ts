import { once } from 'node:events'
import { openDatabase } from '@vid/database/connection'
import type { DB } from '@vid/database/types'
import type { Kysely } from 'kysely'
import {
  createClient,
  type RedisClientOptions,
  type RedisClientType,
} from 'redis'

import { connectObjects, type ObjectStore } from '@vid/object-storage'
import { assignFileTools } from './harness/files'
import { readFile } from 'node:fs/promises'
import type { WorkerEnv } from '@vid/config'
import { openE2BSandbox } from './sandbox/e2b'
import { acceptCommands, initializeCommands } from './commands'
import { relayEvents } from './events'
import { bindExecutionWrites } from './db/run-writes'
import { claimExecutionRun } from './db/execution-leases'
import type { ExecuteRunDependencies } from './execute-run'
import { createPiHarness } from './harness/pi'
import { runWorker } from './run-loop'
import type { WorkerHealth } from './worker-health'

type WorkerAssignment = Partial<
  Pick<ExecuteRunDependencies, 'harness' | 'openSandbox'>
> & { signal?: AbortSignal }

/** Test DI is restricted to an explicit trusted library caller, never environment input. */
export async function startWorker(
  env: WorkerEnv,
  assignment: WorkerAssignment = {},
) {
  const harness =
    assignment.harness === undefined
      ? await loadConfiguredHarness(env)
      : assignment.harness
  const openSandbox =
    assignment.openSandbox === undefined
      ? bindConfiguredSandbox(env)
      : assignment.openSandbox
  // Only a caller supplying both execution capabilities bypasses SDK/storage.
  const needsStorage =
    assignment.harness === undefined || assignment.openSandbox === undefined
  const { objects, fileTools } = connectWorkerStorage(env, needsStorage)
  const connections = {
    DATABASE_URL: env.DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    IO_TIMEOUT_MS: env.IO_TIMEOUT_MS,
    POLL_MS: env.POLL_MS,
  }
  const worker = allocateWorkerProcess(connections, assignment.signal, objects)
  try {
    await worker.connect()
    const consumer = {
      commands: worker.commands,
      blockingReader: worker.blockingReader,
      consumerID: crypto.randomUUID(),
    }
    const initializing = initializeCommands(worker.commands)
    worker.own(initializing)
    await initializing
    worker.signal.throwIfAborted()

    const execution = {
      writes: bindExecutionWrites(worker.db),
      claim: worker.claim,
      harness,
      openSandbox,
      ...(fileTools === undefined ? {} : { fileTools }),
    }
    const scheduling = {
      ownerID: crypto.randomUUID(),
      concurrency: env.CONCURRENCY,
      leaseMs: env.LEASE_MS,
      pollMs: env.POLL_MS,
      signal: worker.signal,
      runTimeoutMs: Math.max(1000, env.SANDBOX_TIMEOUT_MS - 20000),
    }
    worker.own(acceptCommands(worker.db, consumer, worker.signal))
    worker.own(runWorker(execution, scheduling))
    worker.own(
      relayEvents(worker.db, worker.commands, {
        signal: worker.signal,
        pollMs: env.POLL_MS,
      }),
    )
    worker.markReady()
    return { done: worker.done, stop: worker.stop, health: worker.health }
  } catch (error) {
    try {
      await worker.stop()
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Worker startup and cleanup failed',
      )
    }
    throw error
  }
}

async function loadConfiguredHarness(env: WorkerEnv) {
  const systemPrompt = await readFile(env.MODEL_PROMPT_PATH, 'utf8')
  return createPiHarness({
    baseURL: env.MODEL_BASE_URL,
    key: env.MODEL_API_KEY,
    modelID: env.MODEL_ID,
    contextWindow: env.MODEL_CONTEXT_WINDOW,
    maxOutputTokens: env.MODEL_MAX_OUTPUT_TOKENS,
    reasoning: env.MODEL_REASONING,
    input: env.MODEL_INPUT === 'text' ? ['text'] : ['text', 'image'],
    systemPrompt,
    webSearch: {
      authMode: env.WEB_SEARCH_AUTH_MODE,
      ...(env.TAVILY_API_KEY === undefined
        ? {}
        : { apiKey: env.TAVILY_API_KEY }),
    },
  })
}

function bindConfiguredSandbox(
  env: WorkerEnv,
): ExecuteRunDependencies['openSandbox'] {
  const connection = {
    apiURL: env.E2B_API_URL,
    apiKey: env.E2B_API_KEY,
    sandboxURL: env.E2B_SANDBOX_URL,
    template: env.E2B_TEMPLATE,
    timeoutMs: env.SANDBOX_TIMEOUT_MS,
  }
  // Bind credentials here; execution can only allocate the lease's assigned run.
  return async function allocate(lease, signal) {
    return await openE2BSandbox({ ...connection, lease }, signal)
  }
}

function connectWorkerStorage(env: WorkerEnv, needsStorage: boolean) {
  if (!needsStorage) return { objects: undefined, fileTools: undefined }
  const objects = connectObjects({
    endpoint: env.OBJECT_STORAGE_URL,
    region: env.OBJECT_STORAGE_REGION,
    bucket: env.OBJECT_STORAGE_BUCKET,
    accessKeyID: env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
  })
  return {
    objects,
    fileTools: assignFileTools(objects, {
      maxBytes: env.ASSET_MAX_BYTES,
      maxFiles: env.ASSET_MAX_FILES,
      timeoutMs: env.FILE_IO_TIMEOUT_MS,
    }),
  }
}

function allocateWorkerProcess(
  connections: Pick<WorkerEnv, 'DATABASE_URL' | 'REDIS_URL' | 'IO_TIMEOUT_MS'> &
    Partial<Pick<WorkerEnv, 'POLL_MS'>>,
  signal: AbortSignal | undefined,
  objects: ObjectStore | undefined,
) {
  try {
    return new WorkerProcess(connections, signal, objects)
  } catch (cause) {
    try {
      objects?.close()
    } catch (cleanup) {
      throw new AggregateError(
        [cause, cleanup],
        'Worker construction and cleanup failed',
      )
    }
    throw cause
  }
}

/** Connections stay available until intake, publication and active SDK cleanup settle. */
export class WorkerProcess {
  readonly db: Kysely<DB>
  readonly commands: RedisClientType
  readonly blockingReader: RedisClientType
  readonly done: Promise<void>
  private readonly shutdown = new AbortController()
  private readonly tasks: Promise<void>[] = []
  private readonly failures: unknown[] = []
  private closing?: Promise<void>
  private started = false

  markReady() {
    this.started = true
  }

  readonly health = (): WorkerHealth => {
    const phase =
      this.failures.length > 0
        ? 'failed'
        : this.signal.aborted
          ? 'stopping'
          : this.started && this.commands.isReady && this.blockingReader.isReady
            ? 'ready'
            : 'starting'
    return { live: !this.signal.aborted, ready: phase === 'ready', phase }
  }

  readonly claim = (options: Readonly<{ ownerID: string; leaseMs: number }>) =>
    claimExecutionRun(this.db, options)

  constructor(
    private readonly connections: Pick<
      WorkerEnv,
      'DATABASE_URL' | 'REDIS_URL' | 'IO_TIMEOUT_MS'
    > &
      Partial<Pick<WorkerEnv, 'POLL_MS'>>,
    private readonly externalSignal?: AbortSignal,
    private readonly objects?: ObjectStore,
  ) {
    this.db = openDatabase(connections, this.fail)
    const redisOptions = {
      url: connections.REDIS_URL,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 128,
      commandOptions: { timeout: connections.IO_TIMEOUT_MS },
      socket: {
        connectTimeout: connections.IO_TIMEOUT_MS,
        reconnectStrategy: false,
      },
    } satisfies RedisClientOptions
    this.commands = createClient(redisOptions)
    this.blockingReader = createClient(redisOptions)
    this.commands.on('error', this.fail)
    this.blockingReader.on('error', this.fail)
    this.done = once(this.signal, 'abort').then(() => this.close())
    // Consumers observe failure through done/stop; the signal may fire before they attach.
    void this.done.catch(() => {})
    externalSignal?.addEventListener('abort', this.abort, { once: true })
    if (externalSignal?.aborted) this.abort()
  }

  get signal() {
    return this.shutdown.signal
  }

  private readonly abort = () => this.shutdown.abort()

  private readonly fail = (error: unknown) => {
    this.failures.push(error)
    this.abort()
  }

  async connect() {
    this.signal.throwIfAborted()
    const connecting = this.connectRedis()
    this.own(connecting)
    await connecting
  }

  private async connectRedis() {
    const connected = await Promise.allSettled([
      connectBounded(this.commands, this.connections.IO_TIMEOUT_MS),
      connectBounded(this.blockingReader, this.connections.IO_TIMEOUT_MS),
    ])
    this.signal.throwIfAborted()
    for (const connection of connected) {
      if (connection.status === 'rejected') throw connection.reason
    }
  }

  own(task: Promise<void>) {
    this.tasks.push(task.catch(this.fail))
  }

  readonly stop = async () => {
    this.abort()
    await this.done
  }

  close(): Promise<void> {
    // Publish ownership before synchronous abort listeners can reenter close.
    this.closing ??= Promise.resolve().then(() => this.disconnectAfterTasks())
    this.abort()
    return this.closing
  }

  private async disconnectAfterTasks() {
    this.externalSignal?.removeEventListener('abort', this.abort)
    await Promise.all(this.tasks)
    const disconnected = await Promise.allSettled([
      Promise.resolve().then(() => this.objects?.close()),
      Promise.resolve().then(() => {
        if (this.blockingReader.isOpen) this.blockingReader.destroy()
      }),
      Promise.resolve().then(() => {
        if (this.commands.isOpen) this.commands.destroy()
      }),
      Promise.resolve().then(() => this.db.destroy()),
    ])
    for (const connection of disconnected) {
      if (connection.status === 'rejected')
        this.failures.push(connection.reason)
    }
    if (this.failures.length) {
      throw new AggregateError(
        this.failures,
        'Worker process failed; unaccepted deliveries remain pending',
      )
    }
  }
}

async function connectBounded(
  client: {
    isOpen: boolean
    connect: () => Promise<unknown>
    destroy: () => void
  },
  timeoutMs: number,
) {
  const timer = setTimeout(() => {
    if (client.isOpen) client.destroy()
  }, timeoutMs)
  try {
    await client.connect()
  } finally {
    clearTimeout(timer)
  }
}
