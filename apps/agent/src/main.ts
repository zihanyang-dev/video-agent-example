/**
 * Takes turns off the queue and runs them until told to stop.
 *
 * The one place that names an implementation. Everything else in this app depends on a
 * port, so which sandbox and which harness are decisions made here and nowhere else
 * (architecture.md §5, §6).
 *
 * Also the one place that decides what a sandbox is allowed to know. The gateway address
 * goes in because skill scripts need something to call; nothing else does, and in
 * particular not this process's own environment, which is how a developer's credentials
 * would end up inside a container running commands a model wrote.
 */
import { createRedisTurnQueue } from '@vid/queue'
import {
  createPostgresMessages,
  createPostgresSessions,
  createRedisLiveStream,
  createS3Files,
} from '@vid/store'
import { SQL } from 'bun'
import { readEnv } from './env'
import { startPiHarness } from './harness/pi'
import { systemPrompt } from './prompt'
import { rentDockerSandbox } from './sandbox/docker'
import { createTurn } from './turn'

const env = readEnv()

const SKILLS: never[] = []

const sql = new SQL(env.DATABASE_URL)
const live = createRedisLiveStream(env.REDIS_URL)

const takeTurn = createTurn({
  rentSandbox: rentDockerSandbox,
  startHarness: startPiHarness,
  live,
  messages: createPostgresMessages(sql),
  sessions: createPostgresSessions(sql),
  files: createS3Files({
    bucket: env.OBJECTS_BUCKET,
    endpoint: env.OBJECTS_ENDPOINT,
    accessKeyId: env.OBJECTS_ACCESS_KEY,
    secretAccessKey: env.OBJECTS_SECRET_KEY,
    region: env.OBJECTS_REGION,
  }),
  model: {
    baseUrl: env.MODEL_BASE_URL,
    apiKey: env.MODEL_API_KEY,
    id: env.MODEL_ID,
    contextWindow: env.MODEL_CONTEXT_WINDOW,
    maxTokens: env.MODEL_MAX_TOKENS,
  },
  sandboxImage: env.SANDBOX_IMAGE,
  sandboxEnv: {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/work',
    VID_GATEWAY: env.GATEWAY_URL,
  },
  // Empty until skills are published to object storage and carried in with the workspace.
  // The agent finds them by reading the directory, so nothing here changes when they exist.
  skills: SKILLS,
  systemPrompt: systemPrompt(SKILLS),
})

const queue = createRedisTurnQueue({
  url: env.REDIS_URL,
  consumer: env.AGENT_NAME,
  // A turn stays claimed, so this is the only notice anyone gets that it needs a person
  // (architecture.md §4).
  onFailed: (turn, error) => {
    console.error(
      `turn ${turn.turnID} on thread ${turn.threadID} failed and is still claimed`,
      error,
    )
  },
})

/**
 * Stop claiming, finish what is running, then let go of the connections.
 *
 * A turn runs for minutes. Exiting on the signal instead would leave a sandbox running, a
 * conversation half written, and a person watching a page that never finishes -- which is
 * why this process is separate from the one that serves HTTP in the first place
 * (architecture.md §1).
 */
const drain = async (): Promise<void> => {
  await queue.close()
  live.close()
  await sql.close()
  process.exit(0)
}

process.on('SIGTERM', () => void drain())
process.on('SIGINT', () => void drain())

console.log(`${env.AGENT_NAME} taking turns`)
await queue.take(takeTurn)
