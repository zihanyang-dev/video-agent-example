import { SQL } from 'bun'
import { createS3Files } from '@vid/object-storage'
import { createRedisMailbox, relay } from '@vid/queue'
import type { Env } from './env'
import { createConversation } from './modules/conversation'
import { createPostgresConversations } from './modules/conversation/infrastructure/persistence/conversations'
import { createPostgresExecutionResults } from './modules/conversation/infrastructure/persistence/execution-results'
import { publishCommands } from './modules/conversation/infrastructure/execution/commands'
import { receiveExecution } from './modules/conversation/presentation/events/execution'
import { createRoutes } from './modules/conversation/presentation/http/routes'

/** Own the HTTP listener, queue loops and clients for one server process. */
export const serve = async (env: Env): Promise<void> => {
  const { app, sql, commands, results } = connectServer(env)
  const server = Bun.serve({ port: env.PORT, fetch: app.fetch, idleTimeout: 0 })
  const stopping = new AbortController()
  const stop = (): void => stopping.abort()

  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)

  const background = [
    relay({
      publishPending: () => publishCommands(sql, commands),
      signal: stopping.signal,
      intervalMs: 100,
    }),
    results.consume(receiveExecution(createPostgresExecutionResults(sql)), stopping.signal),
  ]
  console.log(`server listening on ${server.port}`)

  try {
    await Promise.all(background)
  } finally {
    // Settle queue operations before closing the clients they are still using.
    stopping.abort()
    await Promise.allSettled(background)
    await server.stop(true)

    commands.close()
    results.close()
    await sql.close()

    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
}

/** Connect product-owned adapters and expose only HTTP operations to incoming requests. */
const connectServer = (env: Env) => {
  const sql = new SQL(env.DATABASE_URL, { connection: { role: 'vid_product' } })

  const commands = createRedisMailbox({
    url: env.REDIS_URL,
    stream: 'execution:commands',
    group: 'agents',
    consumer: 'server',
  })
  const results = createRedisMailbox({
    url: env.REDIS_URL,
    stream: 'execution:events',
    group: 'servers',
    consumer: crypto.randomUUID(),
  })

  const files = createS3Files({
    bucket: env.OBJECTS_BUCKET,
    endpoint: env.OBJECTS_ENDPOINT,
    accessKeyId: env.OBJECTS_ACCESS_KEY,
    secretAccessKey: env.OBJECTS_SECRET_KEY,
    region: env.OBJECTS_REGION,
  })

  const store = createPostgresConversations(sql)
  const app = createRoutes({
    store,
    conversation: createConversation(store),
    sign: files.downloadUrl,
    readerOf: readIdentity,
  })

  return { app, sql, commands, results }
}

/** Development identity boundary; conversation ownership is checked by each use case. */
const readIdentity = async (request: Request) => {
  const userID = request.headers.get('x-user-id')
  return userID === null || userID === '' ? null : { userID }
}
