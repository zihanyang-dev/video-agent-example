/**
 * Serves browsers. Holds no provider credentials and starts no turns itself.
 *
 * Separate from the agent because of lifetimes, not load: an HTTP connection is seconds and
 * a turn is minutes, and shipping a front-end fix must not kill conversations that are half
 * way through (architecture.md §1).
 */
import { createRedisInterrupts, createRedisTurnQueue } from '@vid/queue'
import { createPostgresMessages, createRedisLiveStream, createS3Files } from '@vid/store'
import { SQL } from 'bun'
import { createRoutes } from './api/routes'
import { readEnv } from './env'

const env = readEnv()

const sql = new SQL(env.DATABASE_URL)
const live = createRedisLiveStream(env.REDIS_URL)
const interrupts = createRedisInterrupts(env.REDIS_URL)
const files = createS3Files({
  bucket: env.OBJECTS_BUCKET,
  endpoint: env.OBJECTS_ENDPOINT,
  accessKeyId: env.OBJECTS_ACCESS_KEY,
  secretAccessKey: env.OBJECTS_SECRET_KEY,
  region: env.OBJECTS_REGION,
})
const queue = createRedisTurnQueue({
  url: env.REDIS_URL,
  consumer: 'server',
  // This process only ever puts turns in. Nothing it owns can fail this way.
  onFailed: () => {},
})

const app = createRoutes({
  queue,
  messages: createPostgresMessages(sql),
  live,
  // Not authentication, and not pretending to be. Whatever a session actually looks like
  // replaces this one function, and nothing else changes.
  readerOf: async (request) => {
    const userID = request.headers.get('x-user-id')
    return userID === null || userID === '' ? null : { userID }
  },
  stop: (threadID) => interrupts.request(threadID),
  // Only the one function, not the whole store: a page load needs a link, not a file.
  sign: (key) => files.downloadUrl(key),
  newTurnID: () => crypto.randomUUID(),
  newThreadID: () => crypto.randomUUID(),
})

const server = Bun.serve({ port: env.PORT, fetch: app.fetch, idleTimeout: 0 })

const stop = async (): Promise<void> => {
  // `true` closes the open connections rather than waiting for them. An event stream never
  // finishes on its own, so waiting would hang forever -- and there is nothing to wait for:
  // each browser reconnects and resumes from the position it already has, which is what the
  // positions are for. Redis closes only afterwards, because closing it under a blocked read
  // raises from a call nobody is waiting on any more.
  await server.stop(true)
  await queue.close()
  live.close()
  await sql.close()
  process.exit(0)
}

process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())

console.log(`server on ${server.port}`)
