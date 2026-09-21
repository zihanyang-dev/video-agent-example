import { SQL } from 'bun'
import { z } from 'zod'
import { createS3Files, type Files } from '@vid/object-storage'
import { createRedisMailbox, relay } from '@vid/queue'
import { mintTurnToken } from '@vid/turn-token'
import type { Env } from './env'
import { createExecuteRun } from './application/execute-run'
import { scheduleRuns } from './application/schedule-runs'
import { systemPrompt } from './application/agent-instructions'
import type { SkillIndex } from './application/ports/harness'
import { startPiHarness } from './infrastructure/harness/pi'
import { rentDockerSandbox } from './infrastructure/sandbox/docker'
import { createWorkspace } from './infrastructure/workspace/files'
import { createPostgresExecutionStore } from './infrastructure/persistence/execution-store'
import { publishEvents } from './infrastructure/messaging/events'
import { receiveCommand } from './presentation/commands/execution'

export const work = async (env: Env): Promise<void> => {
  const sql = new SQL(env.DATABASE_URL, { connection: { role: 'vid_execution' } })

  // A restart must not inherit an old lease merely because its deployment label stayed the same.
  const owner = `${env.AGENT_NAME}:${crypto.randomUUID()}`
  const commands = createRedisMailbox({
    url: env.REDIS_URL,
    stream: 'execution:commands',
    group: 'agents',
    consumer: owner,
  })
  const events = createRedisMailbox({
    url: env.REDIS_URL,
    stream: 'execution:events',
    group: 'servers',
    consumer: owner,
  })

  const store = createPostgresExecutionStore(sql, env.LEASE_MS)
  const execute = await assembleExecution(env, store)

  const stopping = new AbortController()
  const stop = (): void => stopping.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)

  const background = [
    commands.consume(receiveCommand(store), stopping.signal),
    relay({
      publishPending: () => publishEvents(sql, events),
      signal: stopping.signal,
      intervalMs: env.POLL_MS,
    }),
    scheduleRuns({
      store,
      execute,
      owner,
      concurrency: env.TURN_CONCURRENCY,
      pollMs: env.POLL_MS,
      signal: stopping.signal,
    }),
  ]

  console.log(`${owner} accepting execution commands`)
  try {
    await Promise.all(background)
  } finally {
    stopping.abort()
    await Promise.allSettled(background)
    await publishEvents(sql, events)
    commands.close()
    events.close()
    await sql.close()
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
}

const SkillCatalog = z.array(
  z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    dir: z.string().min(1),
  }),
)

const loadSkills = async (files: Files): Promise<SkillIndex[]> => {
  const skills = SkillCatalog.parse(
    JSON.parse(new TextDecoder().decode(await files.get('skills/index.json'))),
  )
  return skills.map((skill) => ({ ...skill, dir: `/work/skills/${skill.dir}` }))
}

const executionSettings = (env: Env, skills: SkillIndex[]) => ({
  model: {
    baseUrl: env.MODEL_BASE_URL,
    apiKey: env.MODEL_API_KEY,
    id: env.MODEL_ID,
    contextWindow: env.MODEL_CONTEXT_WINDOW,
    maxTokens: env.MODEL_MAX_TOKENS,
  },
  skills,
  systemPrompt: systemPrompt(skills),
  sandboxImage: env.SANDBOX_IMAGE,
  sandboxNetwork: env.SANDBOX_NETWORK,
  pollMs: env.POLL_MS,
  sandboxEnv: async (run: { turnID: string; threadID: string }) => ({
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/work',
    VID_GATEWAY: env.GATEWAY_URL,
    VID_SEEDANCE_MODEL: env.SEEDANCE_MODEL,
    VID_SEEDREAM_MODEL: env.SEEDREAM_MODEL,
    VID_TURN_TOKEN: await mintTurnToken(
      env.TURN_TOKEN_SECRET,
      { turnID: run.turnID, threadID: run.threadID },
      Date.now(),
    ),
  }),
})

const assembleExecution = async (
  env: Env,
  store: ReturnType<typeof createPostgresExecutionStore>,
) => {
  const files = createS3Files({
    bucket: env.OBJECTS_BUCKET,
    endpoint: env.OBJECTS_ENDPOINT,
    accessKeyId: env.OBJECTS_ACCESS_KEY,
    secretAccessKey: env.OBJECTS_SECRET_KEY,
    region: env.OBJECTS_REGION,
  })
  const skills = await loadSkills(files)

  return createExecuteRun({
    ...executionSettings(env, skills),
    store,
    workspace: createWorkspace(files),
    startHarness: startPiHarness,
    rentSandbox: (spec) => rentDockerSandbox(spec, env.SANDBOX_DNS),
  })
}
