import { connectObjects, type ObjectStore } from '@vid/object-storage'
import type { ServerEnv } from '@vid/config'
import type { DB } from '@vid/database/types'
import { executionStreams } from '@vid/contract/execution'
import type { Kysely } from 'kysely'
import { openDatabase } from '@vid/database/connection'
import { createClient, type RedisClientType } from 'redis'
import { createAuthentication } from './identity/authentication'
import { createHTTP } from './http'
import { acceptEventDeliveries } from './conversation/event-intake'
import { publishPendingCommands } from './conversation/command-publication'

/** One owner for construction, HTTP, subscriptions, background work and release. */
export async function startServer(
  env: ServerEnv,
  options: { port?: number; signal?: AbortSignal } = {},
) {
  const shutdown = new AbortController()
  const requests = new Map<Promise<unknown>, boolean>()
  const background: Promise<void>[] = []
  const failures: unknown[] = []
  // Partial construction is real: cleanup owns every handle already allocated.
  let objectStore: ObjectStore | undefined
  let database: Kysely<DB> | undefined
  let commandClient: RedisClientType | undefined
  let eventReader: RedisClientType | undefined
  let server: ReturnType<typeof Bun.serve> | undefined
  let closing: Promise<void> | undefined
  const abort = () => shutdown.abort()
  const fail = (
    stage:
      | 'dbtransport'
      | 'rediscommand'
      | 'redisread'
      | 'eventreceipt'
      | 'commandpublication'
      | 'httphandler',
    cause: unknown,
  ) => {
    failures.push(cause)
    // Classify failures without logging private text or native driver parameters.
    console.error('Server process failed', {
      stage,
      rejectedType: typeof cause,
      isError: cause instanceof Error,
    })
    abort()
  }
  async function settle(tasks: readonly Promise<unknown>[]) {
    const settled = await Promise.allSettled(tasks)
    for (const task of settled) if (task.status === 'rejected') failures.push(task.reason)
  }
  function close(): Promise<void> {
    // Install the shared receipt before abort or native cleanup can reenter.
    closing ??= Promise.resolve().then(async () => {
      options.signal?.removeEventListener('abort', abort)
      await settle([Promise.resolve().then(() => server?.stop(true))])
      await settle([...requests.keys()])
      await settle(background)
      // Synchronous failures also become receipts; no sibling is skipped.
      await settle([
        Promise.resolve().then(() => eventReader?.destroy()),
        Promise.resolve().then(() => commandClient?.destroy()),
        Promise.resolve().then(() => objectStore?.close()),
        Promise.resolve().then(() => database?.destroy()),
      ])
      if (failures.length)
        throw new AggregateError(
          failures,
          'Server process failed; unaccepted deliveries remain pending',
        )
    })
    abort()
    return closing
  }

  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    options.signal?.throwIfAborted()
    shutdown.signal.throwIfAborted()
    const objects = (objectStore = connectObjects({
      endpoint: env.OBJECT_STORAGE_URL,
      region: env.OBJECT_STORAGE_REGION,
      bucket: env.OBJECT_STORAGE_BUCKET,
      accessKeyID: env.OBJECT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    }))
    const db = (database = openDatabase(env, (cause) => fail('dbtransport', cause)))
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
    const commands = (commandClient = createClient(redisOptions))
    const blockingReader = (eventReader = createClient(redisOptions))
    commands.on('error', (cause) => fail('rediscommand', cause))
    blockingReader.on('error', (cause) => fail('redisread', cause))
    const connected = await Promise.allSettled([
      connectBounded(commands, env.IO_TIMEOUT_MS),
      connectBounded(blockingReader, env.IO_TIMEOUT_MS),
    ])
    const failed = connected.find((connection) => connection.status === 'rejected')
    if (failed) throw failed.reason
    shutdown.signal.throwIfAborted()
    await commands
      .xGroupCreate(executionStreams.events, executionStreams.eventGroup, '0-0', { MKSTREAM: true })
      .catch((cause: unknown) => {
        if (!(cause instanceof Error) || !cause.message.startsWith('BUSYGROUP ')) throw cause
      })
    shutdown.signal.throwIfAborted()
    const route = createHTTP(db, {
      authentication: createAuthentication(db, {
        baseURL: env.AUTH_BASE_URL,
        secret: env.AUTH_SECRET,
        githubClientID: env.GITHUB_CLIENT_ID,
        githubClientSecret: env.GITHUB_CLIENT_SECRET,
      }),
      bodyCollection: {
        signal: shutdown.signal,
        timeoutMs: env.FILE_IO_TIMEOUT_MS,
      },
      maxAssetBytes: env.ASSET_MAX_BYTES,
      files: {
        objects,
        maxAssetBytes: env.ASSET_MAX_BYTES,
        timeoutMs: env.FILE_IO_TIMEOUT_MS,
        signal: shutdown.signal,
      },
      signal: shutdown.signal,
      pollIntervalMs: env.POLL_MS,
      ownRead(pending) {
        // An SSE Response resolves before its pull. Own only outstanding work,
        // not a second stream/subscription lifecycle and completion registry.
        requests.set(pending, false)
        void pending.then(() => requests.delete(pending))
      },
    })
    server = Bun.serve({
      hostname: '0.0.0.0',
      maxRequestBodySize: Math.max(65536, env.ASSET_MAX_BYTES),
      port: options.port ?? env.PORT,
      fetch(request) {
        // Route work, native HTTP transfer and SSE are different lifetimes.
        if (requests.size >= 16 || (server?.pendingRequests ?? 0) >= 16)
          return new Response('Too many active requests. Try again.', {
            status: 429,
          })
        const fileRequest = /\/assets(?:\/|$)/.test(new URL(request.url).pathname)
        if (fileRequest && [...requests.values()].filter(Boolean).length >= 4)
          return new Response('Too many active file requests. Try again.', {
            status: 429,
          })
        const pending = (async () => {
          if (shutdown.signal.aborted) return new Response('Stopping', { status: 503 })
          try {
            return await route(request)
          } catch (cause) {
            fail('httphandler', cause)
            return new Response('Server unavailable. Try again after restart.', { status: 503 })
          }
        })()
        requests.set(pending, fileRequest)
        void pending.then(() => requests.delete(pending))
        return pending
      },
    })

    const assetLimits = {
      maxBytes: env.ASSET_MAX_BYTES,
      maxFiles: env.ASSET_MAX_FILES,
    }
    background.push(
      acceptEventDeliveries(db, {
        commands,
        blockingReader,
        assetLimits,
        signal: shutdown.signal,
        onFailure: fail,
      }),
      publishPendingCommands(db, commands, {
        signal: shutdown.signal,
        pollMs: env.POLL_MS,
      }).catch((cause: unknown) => fail('commandpublication', cause)),
    )
    const done = new Promise<void>((resolve) => {
      shutdown.signal.addEventListener('abort', () => resolve(), { once: true })
      if (shutdown.signal.aborted) resolve()
    }).then(close)
    // Library callers may await stop instead; done still owns its rejection.
    void done.catch(() => {})
    return { url: `http://127.0.0.1:${server.port}`, done, stop: close }
  } catch (cause) {
    try {
      await close()
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Server startup failed and cleanup also failed')
    }
    throw cause
  }
}

/** Own the full native initialization receipt, not only TCP connectTimeout. */
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
