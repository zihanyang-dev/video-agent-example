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
import { createRedisTurnQueue, type TurnRequest } from '@vid/queue'
import {
  createPostgresMessages,
  createPostgresSessions,
  createRedisLiveStream,
  createS3Files,
} from '@vid/store'
import { mintTurnToken } from '@vid/turn-token'
import { SQL } from 'bun'
import { z } from 'zod'
import { readEnv } from './env'
import { startPiHarness } from './harness/pi'
import { systemPrompt } from './prompt'
import { createInFlight } from './in-flight'
import { rentDockerSandbox } from './sandbox/docker'
import { createTurn } from './turn'

/** What `bun run skills` publishes beside the skills themselves. */
const SkillIndex = z.array(
  z.object({ name: z.string().min(1), description: z.string().min(1), dir: z.string().min(1) }),
)

const env = readEnv()

const sql = new SQL(env.DATABASE_URL)
const live = createRedisLiveStream(env.REDIS_URL)
const files = createS3Files({
  bucket: env.OBJECTS_BUCKET,
  endpoint: env.OBJECTS_ENDPOINT,
  accessKeyId: env.OBJECTS_ACCESS_KEY,
  secretAccessKey: env.OBJECTS_SECRET_KEY,
  region: env.OBJECTS_REGION,
})

/**
 * Which skills exist, read once at startup.
 *
 * Only their names and descriptions -- the bodies stay in the sandbox where the agent reads
 * them when a task matches (architecture.md §7). Published separately from a deploy, so a
 * restart is how this process notices a new one.
 */
const SKILLS = SkillIndex.parse(
  JSON.parse(new TextDecoder().decode(await files.get('skills/index.json'))),
)

const inFlight = createInFlight()
const messages = createPostgresMessages(sql)

const takeTurn = createTurn({
  rentSandbox: rentDockerSandbox,
  startHarness: startPiHarness,
  inFlight,
  live,
  messages,
  sessions: createPostgresSessions(sql),
  files,
  model: {
    baseUrl: env.MODEL_BASE_URL,
    apiKey: env.MODEL_API_KEY,
    id: env.MODEL_ID,
    contextWindow: env.MODEL_CONTEXT_WINDOW,
    maxTokens: env.MODEL_MAX_TOKENS,
  },
  sandboxImage: env.SANDBOX_IMAGE,
  sandboxNetwork: env.SANDBOX_NETWORK,
  // Spelled out, never assembled from this process's environment: a harness hands its tools
  // the host's entire environment, and forwarding that is how a developer's credentials end
  // up inside a container running commands a model wrote (architecture.md §5).
  sandboxEnv: async (request) => ({
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/work',
    VID_GATEWAY: env.GATEWAY_URL,
    VID_SEEDANCE_MODEL: env.SEEDANCE_MODEL,
    VID_SEEDREAM_MODEL: env.SEEDREAM_MODEL,
    VID_TURN_TOKEN: await mintTurnToken(
      env.TURN_TOKEN_SECRET,
      { turnID: request.turnID, threadID: request.threadID },
      Date.now(),
    ),
  }),
  skills: SKILLS.map((skill) => ({ ...skill, dir: `/work/skills/${skill.dir}` })),
  systemPrompt: systemPrompt(SKILLS),
})

/**
 * What to do with a turn that arrives.
 *
 * Two outcomes, and which one happens is not this file's decision -- `in-flight.ts` owns the
 * rule that a thread has one turn at a time. Here it is only carried out.
 *
 * A thread already working takes the message into the turn that is running. That is what a
 * person means when they type something while watching it work, and waiting out the nine
 * minutes to tell the agent it is going the wrong way is the behaviour worth removing.
 *
 * The message is written down either way, so the conversation reads the same whether it
 * became a turn or joined one.
 */
const dispatch = async (turn: TurnRequest): Promise<void> => {
  if (!inFlight.offer(turn.threadID, turn.message)) {
    await takeTurn(turn)
    return
  }

  await messages.append(turn.threadID, {
    id: `${turn.turnID}:asked`,
    role: 'user',
    content: turn.message,
  })
}

const queue = createRedisTurnQueue({
  url: env.REDIS_URL,
  consumer: env.AGENT_NAME,
  // How many threads this process works on at once. Each turn holds a sandbox for its whole
  // life, so this is a statement about containers, not about the loop -- raise it when the
  // machine has room, and never past what Docker on it will carry (architecture.md §1).
  concurrency: env.TURN_CONCURRENCY,
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
await queue.take(dispatch)
