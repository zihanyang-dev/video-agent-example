import { once } from 'node:events'
import { openExecutionDatabase, type ExecutionDatabase } from './db/connection'
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

type WorkerAssignment = Partial<
  Pick<ExecuteRunDependencies, 'harness' | 'openSandbox'>
> & { signal?: AbortSignal }

/** Test DI is restricted to an explicit trusted library caller, never environment input. */
export async function startWorker(
  env: WorkerEnv,
  assignment: WorkerAssignment = {},
) {
  const assigned = await resolveExecutionAssignment(env, assignment)
  const { objects, fileTools } = assignedStorage(env, assignment)
  const connections = {
    DATABASE_URL: env.DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    IO_TIMEOUT_MS: env.IO_TIMEOUT_MS,
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
      claim: (options: Readonly<{ ownerID: string; leaseMs: number }>) =>
        claimExecutionRun(worker.db, options),
      ...assigned,
      ...(fileTools === undefined ? {} : { fileTools }),
    }
    const scheduling = {
      ownerID: crypto.randomUUID(),
      concurrency: env.CONCURRENCY,
      leaseMs: env.LEASE_MS,
      pollMs: env.POLL_MS,
      signal: worker.signal,
    }
    worker.own(acceptCommands(worker.db, consumer, worker.signal))
    worker.own(runWorker(execution, scheduling))
    worker.own(
      relayEvents(worker.db, worker.commands, {
        signal: worker.signal,
        pollMs: env.POLL_MS,
      }),
    )
    return { done: worker.done, stop: worker.stop }
  } catch (error) {
    await worker.stop()
    throw error
  }
}

async function resolveExecutionAssignment(
  env: WorkerEnv,
  assignment: WorkerAssignment,
) {
  const harness =
    assignment.harness === undefined
      ? await assignedHarness(env)
      : assignment.harness
  const openSandbox =
    assignment.openSandbox === undefined
      ? assignedSandbox(env)
      : assignment.openSandbox
  return {
    harness,
    openSandbox,
  }
}

async function assignedHarness(env: WorkerEnv) {
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
  })
}

function assignedSandbox(
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

function assignedStorage(env: WorkerEnv, assignment: WorkerAssignment) {
  let objects: ObjectStore | undefined
  // Both capabilities must be supplied by a trusted library caller to bypass SDK/storage.
  if (assignment.harness !== undefined && assignment.openSandbox !== undefined)
    return { objects, fileTools: undefined }
  objects = connectObjects({
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
  connections: Pick<WorkerEnv, 'DATABASE_URL' | 'REDIS_URL' | 'IO_TIMEOUT_MS'>,
  signal: AbortSignal | undefined,
  objects: ObjectStore | undefined,
) {
  try {
    return new WorkerProcess(connections, signal, objects)
  } catch (cause) {
    objects?.close()
    throw cause
  }
}

/** Connections stay available until intake, publication and active SDK cleanup settle. */
export class WorkerProcess {
  readonly db: ExecutionDatabase
  readonly commands: RedisClientType
  readonly blockingReader: RedisClientType
  readonly done: Promise<void>
  private readonly shutdown = new AbortController()
  private readonly tasks: Promise<void>[] = []
  private readonly failures: unknown[] = []
  private closing?: Promise<void>

  constructor(
    private readonly connections: Pick<
      WorkerEnv,
      'DATABASE_URL' | 'REDIS_URL' | 'IO_TIMEOUT_MS'
    >,
    private readonly externalSignal?: AbortSignal,
    private readonly objects?: ObjectStore,
  ) {
    this.db = openExecutionDatabase(connections, this.fail)
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
    if (this.closing !== undefined) return this.closing
    this.abort()
    this.closing = this.disconnectAfterTasks()
    return this.closing
  }

  private async disconnectAfterTasks() {
    this.externalSignal?.removeEventListener('abort', this.abort)
    await Promise.all(this.tasks)
    this.objects?.close()
    const disconnected = await Promise.allSettled([
      this.disconnectRedis(),
      this.db.destroy(),
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

  private async disconnectRedis() {
    if (this.blockingReader.isOpen) this.blockingReader.destroy()
    if (this.commands.isOpen) this.commands.destroy()
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
