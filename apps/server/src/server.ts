import { connectObjects, type ObjectStore } from '@vid/object-storage'
import type { ServerEnv } from '@vid/config'
import type { DB } from '@vid/database/types'
import { executionStreams } from '@vid/contract/execution'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { createClient, type RedisClientType } from 'redis'
import { createAuthentication } from './identity/authentication'
import { createHTTP } from './http'
import type { EventSubscription } from './conversation/event-stream'
import { consumeEventBatch } from './conversation/execution-events'
import { publishPendingCommands } from './conversation/command-publication'

/** One process owns HTTP requests, subscriptions, Redis tasks and connections. */
export class Server {
  private readonly shutdown = new AbortController()
  private readonly objects: ObjectStore
  private readonly db: Kysely<DB>
  private readonly commands: RedisClientType
  private readonly blockingReader: RedisClientType
  private fileRequests = 0
  private readonly requests = new Set<Promise<Response>>()
  private readonly subscriptions = new Set<EventSubscription>()
  private eventAcceptance: Promise<void> = Promise.resolve()
  private commandPublication: Promise<void> = Promise.resolve()
  private readonly failures: unknown[] = []
  private server: ReturnType<typeof Bun.serve> | undefined
  private closing: Promise<void> | undefined

  constructor(
    private readonly env: ServerEnv,
    private readonly externalSignal?: AbortSignal,
  ) {
    this.objects = connectObjects({
      endpoint: env.OBJECT_STORAGE_URL,
      region: env.OBJECT_STORAGE_REGION,
      bucket: env.OBJECT_STORAGE_BUCKET,
      accessKeyID: env.OBJECT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    })
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 8,
      connectionTimeoutMillis: env.IO_TIMEOUT_MS,
      statement_timeout: env.IO_TIMEOUT_MS,
      lock_timeout: env.IO_TIMEOUT_MS,
      idle_in_transaction_session_timeout: env.IO_TIMEOUT_MS,
    })
    pool.on('error', this.fail)
    this.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) })
    const redisOptions = {
      url: env.REDIS_URL,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 128,
      commandOptions: { timeout: env.IO_TIMEOUT_MS },
      socket: {
        connectTimeout: env.IO_TIMEOUT_MS,
        reconnectStrategy: false as const,
      },
    }
    this.commands = createClient(redisOptions)
    this.blockingReader = createClient(redisOptions)
    this.commands.on('error', this.fail)
    this.blockingReader.on('error', this.fail)
  }

  async start(port: number) {
    this.externalSignal?.addEventListener('abort', this.abort, { once: true })
    if (this.externalSignal?.aborted) this.abort()
    this.shutdown.signal.throwIfAborted()
    await this.connectRedis()
    try {
      await this.commands.xGroupCreate(
        executionStreams.events,
        executionStreams.eventGroup,
        '0-0',
        { MKSTREAM: true },
      )
    } catch (cause) {
      if (!(cause instanceof Error) || !cause.message.startsWith('BUSYGROUP '))
        throw cause
    }
    this.shutdown.signal.throwIfAborted()
    const url = this.listen(port)
    this.eventAcceptance = this.acceptEventDeliveries().catch(this.fail)
    this.commandPublication = publishPendingCommands(this.db, this.commands, {
      signal: this.shutdown.signal,
      pollMs: this.env.POLL_MS,
    }).catch(this.fail)
    const done = this.waitForShutdown()
    // Library callers can await done or stop; a rejected done is still owned.
    void done.catch(() => {})
    return {
      url,
      done,
      stop: this.close,
    }
  }

  private async connectRedis() {
    const connected = await Promise.allSettled([
      connectBounded(this.commands, this.env.IO_TIMEOUT_MS),
      connectBounded(this.blockingReader, this.env.IO_TIMEOUT_MS),
    ])
    this.shutdown.signal.throwIfAborted()
    for (const connection of connected)
      if (connection.status === 'rejected') throw connection.reason
  }

  private listen(port: number) {
    const route = createHTTP(this.db, {
      authentication: createAuthentication(this.db, {
        baseURL: this.env.AUTH_BASE_URL,
        secret: this.env.AUTH_SECRET,
        githubClientID: this.env.GITHUB_CLIENT_ID,
        githubClientSecret: this.env.GITHUB_CLIENT_SECRET,
      }),
      files: {
        objects: this.objects,
        maxAssetBytes: this.env.ASSET_MAX_BYTES,
        timeoutMs: this.env.FILE_IO_TIMEOUT_MS,
        signal: this.shutdown.signal,
      },
      signal: this.shutdown.signal,
      pollIntervalMs: this.env.POLL_MS,
      registerSubscription: this.registerSubscription,
    })
    this.server = Bun.serve({
      hostname: '0.0.0.0',
      maxRequestBodySize: Math.max(65536, this.env.ASSET_MAX_BYTES),
      port,
      fetch: (request) => {
        // Four buffered file requests bound peak file bytes; ordinary HTTP and
        // subscriptions are also capped instead of growing sockets without limit.
        if (
          this.requests.size >= 16 ||
          (this.server?.pendingRequests ?? 0) >= 16 ||
          this.subscriptions.size >= 32
        )
          return new Response('Too many active requests. Try again.', {
            status: 429,
          })
        const fileRequest = /\/assets(?:\/|$)/.test(
          new URL(request.url).pathname,
        )
        if (fileRequest && this.fileRequests >= 4)
          return new Response('Too many active file requests. Try again.', {
            status: 429,
          })
        if (fileRequest) this.fileRequests += 1
        const pending = this.respond(request, route)
        this.requests.add(pending)
        void pending.then(() => {
          this.requests.delete(pending)
          if (fileRequest) this.fileRequests -= 1
        })
        return pending
      },
    })
    return `http://127.0.0.1:${this.server.port}`
  }

  private async respond(
    request: Request,
    route: (request: Request) => Promise<Response>,
  ) {
    if (this.shutdown.signal.aborted)
      return new Response('Stopping', { status: 503 })
    try {
      return await route(request)
    } catch (cause) {
      this.fail(cause)
      return new Response('Server unavailable. Try again after restart.', {
        status: 503,
      })
    }
  }

  private registerSubscription = (subscription: EventSubscription) => {
    this.subscriptions.add(subscription)
    return () => {
      this.subscriptions.delete(subscription)
    }
  }

  private async acceptEventDeliveries() {
    const consumer = crypto.randomUUID()
    let startID = '0-0'
    while (!this.shutdown.signal.aborted) {
      const reclaimed = await this.commands.xAutoClaim(
        executionStreams.events,
        executionStreams.eventGroup,
        consumer,
        1000,
        startID,
        { COUNT: 32 },
      )
      startID = reclaimed.nextId // Advance through pages containing no live entries.
      if (this.shutdown.signal.aborted) return
      await consumeEventBatch(this.db, {
        commands: this.commands,
        assetLimits: {
          maxBytes: this.env.ASSET_MAX_BYTES,
          maxFiles: this.env.ASSET_MAX_FILES,
        },
        messages: reclaimed.messages,
        deletedMessages: reclaimed.deletedMessages,
      })
      if (this.shutdown.signal.aborted) return
      const streams = await this.blockingReader.xReadGroup(
        executionStreams.eventGroup,
        consumer,
        { key: executionStreams.events, id: '>' },
        { COUNT: 32, BLOCK: 200 },
      )
      const messages = streams?.flatMap((stream) => stream.messages) ?? []
      // Deliveries claimed during shutdown stay pending for the replacement.
      if (this.shutdown.signal.aborted) return
      await consumeEventBatch(this.db, {
        commands: this.commands,
        messages,
        assetLimits: {
          maxBytes: this.env.ASSET_MAX_BYTES,
          maxFiles: this.env.ASSET_MAX_FILES,
        },
      })
    }
  }

  private abort = () => {
    this.shutdown.abort()
  }

  private fail = (cause: unknown) => {
    this.failures.push(cause)
    // Error names classify diagnostics without logging driver parameters,
    // validation inputs, private execution text or credentials.
    console.error('Server process failed', {
      classification: 'process-adapter',
      cause: cause instanceof Error ? cause.name : typeof cause,
    })
    this.abort()
  }

  private async waitForShutdown() {
    await new Promise<void>((resolve) => {
      this.shutdown.signal.addEventListener('abort', () => resolve(), {
        once: true,
      })
      if (this.shutdown.signal.aborted) resolve()
    })
    await this.close()
  }

  close = (): Promise<void> => {
    if (this.closing) return this.closing
    this.abort()
    this.closing = this.settleAndDisconnect()
    return this.closing
  }

  private async settleAndDisconnect() {
    this.externalSignal?.removeEventListener('abort', this.abort)
    await this.server?.stop(true)
    await Promise.all(this.requests)
    // HTTP Response promises are not subscription lifetimes. Every outstanding
    // pull (including a query already sent to PG) must settle before DB close.
    await Promise.all(
      [...this.subscriptions].map((subscription) => subscription.close()),
    )
    await Promise.all([this.eventAcceptance, this.commandPublication])
    if (this.blockingReader.isOpen) this.blockingReader.destroy()
    if (this.commands.isOpen) this.commands.destroy()
    this.objects.close()
    await this.db.destroy()
    if (this.failures.length)
      throw new AggregateError(
        this.failures,
        'Server process failed; unaccepted deliveries remain pending',
      )
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

/** The creator owns cleanup even when startup fails before HTTP is listening. */
export async function startServer(
  env: ServerEnv,
  options: { port?: number; signal?: AbortSignal } = {},
) {
  const server = new Server(env, options.signal)
  try {
    return await server.start(
      options.port === undefined ? env.PORT : options.port,
    )
  } catch (cause) {
    await server.close()
    throw cause
  }
}
