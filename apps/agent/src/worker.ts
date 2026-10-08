import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import type { Kysely } from 'kysely'
import { createClient, type RedisClientOptions, type RedisClientType } from 'redis'

import type { WorkerEnv } from '@vid/config'
import { openDatabase } from '@vid/database/connection'
import type { DB } from '@vid/database/types'
import { connectObjects, type ObjectStore } from '@vid/object-storage'

import { acceptCommands, initializeCommands } from './execution/commands'
import { claimExecutionRun, recoverNativeRequests } from './execution/db/execution-leases'
import { bindExecutionWrites } from './execution/db/run-writes'
import { relayEvents } from './execution/events'
import type { ExecuteRunDependencies } from './contract.ts'
import { assignFileTools } from './harness/files'
import { createPiHarness } from './harness/pi/adapter'
import { createOpenAIHarness } from './harness/openai/adapter'
import { acquireNativeStateLock } from './native-state-lock'
import { runWorker } from './execution/run-loop'
import { openE2BSandbox } from './sandbox/e2b'
import type { WorkerHealth } from './worker-health'

type WorkerAssignment = {
  readonly harness?: ExecuteRunDependencies['harness']
  readonly openSandbox?: ExecuteRunDependencies['openSandbox']
  signal?: AbortSignal
}

type WorkerConnections = Pick<WorkerEnv, 'DATABASE_URL' | 'REDIS_URL' | 'IO_TIMEOUT_MS'> & {
  POLL_MS?: WorkerEnv['POLL_MS']
  AGENT_ENGINE?: WorkerEnv['AGENT_ENGINE']
  RUN_TIMEOUT_MS?: WorkerEnv['RUN_TIMEOUT_MS']
}

/** Test DI is restricted to an explicit trusted library caller, never environment input. */
export async function startWorker(env: WorkerEnv, assignment: WorkerAssignment = {}) {
  // Only a caller supplying both execution capabilities bypasses SDK/storage.
  const needsStorage = assignment.harness === undefined || assignment.openSandbox === undefined
  const { objects, fileTools } = connectWorkerStorage(env, needsStorage)
  const connections = {
    DATABASE_URL: env.DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    IO_TIMEOUT_MS: env.IO_TIMEOUT_MS,
    POLL_MS: env.POLL_MS,
    AGENT_ENGINE: env.AGENT_ENGINE,
    RUN_TIMEOUT_MS: env.RUN_TIMEOUT_MS,
  }
  const worker = allocateWorkerProcess(connections, assignment.signal, objects)
  try {
    // Resource-owned setup belongs inside the same cleanup scope as connections.
    // Defaults apply only to undefined, preserving trusted capability injection.
    const {
      harness = await loadConfiguredHarness(env),
      openSandbox = bindConfiguredSandbox(env, worker.fail),
    } = assignment
    await worker.connect(needsStorage ? env.NATIVE_STATE_PATH : undefined)
    if (needsStorage) {
      const recovering = recoverNativeRequests(worker.db, harness.completed)
      worker.own(recovering)
      await recovering
    }
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
        worker.claim(options, harness.completed),
      harness,
      openSandbox,
      onNativeUnsettled: worker.fail,
      ...(fileTools === undefined ? {} : { fileTools }),
    }
    const scheduling = {
      ownerID: crypto.randomUUID(),
      concurrency: env.CONCURRENCY,
      leaseMs: env.LEASE_MS,
      pollMs: env.POLL_MS,
      signal: worker.signal,
      runTimeoutMs: env.RUN_TIMEOUT_MS,
    }
    worker.own(acceptCommands(worker.db, consumer, worker.signal))
    worker.own(runWorker(execution, scheduling))
    worker.own(
      relayEvents(worker.db, worker.commands, {
        signal: worker.signal,
        pollMs: env.POLL_MS,
        retentionMs: env.EVENT_OUTBOX_RETENTION_MS,
      }),
    )
    worker.markReady()
    return { done: worker.done, stop: worker.stop, health: worker.health }
  } catch (error) {
    try {
      await worker.stop()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Worker startup and cleanup failed')
    }
    throw error
  }
}

async function loadConfiguredHarness(env: WorkerEnv) {
  const systemPrompt = await readFile(env.MODEL_PROMPT_PATH, 'utf8')
  const options = {
    statePath: env.NATIVE_STATE_PATH,
    baseURL: env.MODEL_BASE_URL,
    key: env.MODEL_API_KEY,
    modelID: env.MODEL_ID,
    contextWindow: env.MODEL_CONTEXT_WINDOW,
    maxOutputTokens: env.MODEL_MAX_OUTPUT_TOKENS,
    input: env.MODEL_INPUT === 'text' ? (['text'] as const) : (['text', 'image'] as const),
    systemPrompt,
    webSearch: {
      authMode: env.WEB_SEARCH_AUTH_MODE,
      ...(env.TAVILY_API_KEY === undefined ? {} : { apiKey: env.TAVILY_API_KEY }),
    },
  }
  const pi = createPiHarness({
    ...options,
    reasoning: env.MODEL_REASONING,
    ...(env.AGENT_SKILLS_PATH === undefined ? {} : { skillsPath: env.AGENT_SKILLS_PATH }),
  })
  const openai = createOpenAIHarness({ ...options, reasoning: env.MODEL_REASONING ? 'low' : null })
  return {
    completed: async (
      identity: Parameters<NonNullable<ExecuteRunDependencies['harness']['completed']>>[0],
    ) =>
      identity.engine === 'pi' ? await pi.completed!(identity) : await openai.completed!(identity),
    run: async (input: Parameters<ExecuteRunDependencies['harness']['run']>[0]) => {
      if (input.engine === 'pi') return await pi.run(input)
      if (env.AGENT_SKILLS_PATH !== undefined)
        throw new Error('Assigned skill bundle is unsupported by OpenAI harness')
      return await openai.run(input)
    },
  }
}

export function bindConfiguredSandbox(
  env: Pick<
    WorkerEnv,
    'E2B_API_URL' | 'E2B_API_KEY' | 'E2B_SANDBOX_URL' | 'E2B_TEMPLATE' | 'SANDBOX_TIMEOUT_MS'
  >,
  onFailure: (error: unknown) => void,
): ExecuteRunDependencies['openSandbox'] {
  const connection = {
    apiURL: env.E2B_API_URL,
    apiKey: env.E2B_API_KEY,
    sandboxURL: env.E2B_SANDBOX_URL,
    template: env.E2B_TEMPLATE,
    timeoutMs: env.SANDBOX_TIMEOUT_MS,
  }
  // Bind credentials here; allocation receives correlation, not SQL authority.
  return async function allocate(assignment, signal) {
    return await openE2BSandbox({ ...connection, assignment, onFailure }, signal)
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
  connections: WorkerConnections,
  signal: AbortSignal | undefined,
  objects: ObjectStore | undefined,
) {
  try {
    return new WorkerProcess(connections, signal, objects)
  } catch (cause) {
    try {
      objects?.close()
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Worker construction and cleanup failed')
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
  private nativeStateLock?: Awaited<ReturnType<typeof acquireNativeStateLock>>

  markReady() {
    this.started = true
  }

  readonly health = (): WorkerHealth => {
    if (this.failures.length > 0) {
      return { live: !this.signal.aborted, ready: false, phase: 'failed' }
    }
    if (this.signal.aborted) return { live: false, ready: false, phase: 'stopping' }
    if (this.started && this.commands.isReady && this.blockingReader.isReady) {
      return { live: true, ready: true, phase: 'ready' }
    }
    return { live: true, ready: false, phase: 'starting' }
  }

  readonly claim = (
    options: Readonly<{ ownerID: string; leaseMs: number }>,
    getCompleted?: ExecuteRunDependencies['harness']['completed'],
  ) => {
    this.signal.throwIfAborted()
    return claimExecutionRun(this.db, {
      ...options,
      defaultEngine: this.connections.AGENT_ENGINE ?? 'pi',
      getCompleted,
      requestTimeoutMs: this.connections.RUN_TIMEOUT_MS ?? 1800000,
    })
  }

  constructor(
    private readonly connections: WorkerConnections,
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

  readonly fail = (error: unknown) => {
    this.failures.push(error)
    this.abort()
  }

  async connect(statePath?: string) {
    this.signal.throwIfAborted()
    const connecting = this.connectResources(statePath)
    this.own(connecting)
    await connecting
  }

  private async connectResources(statePath?: string) {
    if (statePath !== undefined) this.nativeStateLock = await acquireNativeStateLock(statePath)
    this.signal.throwIfAborted()
    const connected = await Promise.allSettled([
      connectBounded(this.commands, this.connections.IO_TIMEOUT_MS),
      connectBounded(this.blockingReader, this.connections.IO_TIMEOUT_MS),
    ])
    const failures: unknown[] = []
    for (const connection of connected) {
      if (connection.status === 'rejected') failures.push(connection.reason)
    }
    if (this.signal.aborted) {
      this.failures.push(...failures)
      this.signal.throwIfAborted()
    }
    if (failures.length) {
      throw new AggregateError(failures, 'Worker Redis connections failed')
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
      if (connection.status === 'rejected') this.failures.push(connection.reason)
    }
    if (this.failures.length) {
      // Failed bounded cleanup is not proof a detached SDK callback stopped.
      // Keep the kernel lock until the entrypoint physically exits the process.
      throw new AggregateError(
        this.failures,
        'Worker process failed; unaccepted deliveries remain pending',
      )
    }
    await this.nativeStateLock?.close()
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
