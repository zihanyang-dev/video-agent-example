/**
 * The only file that reads `process.env`.
 *
 * Everywhere else receives an `Env` that has already been parsed, so nothing downstream
 * guesses whether a variable exists or what shape it is in (code-style §4.6).
 *
 * Two details are not optional:
 *
 *  - **Blank means unset.** `MODEL_API_KEY=` otherwise reports "wrong format" when the true
 *    answer is "you did not set it" -- two sentences pointing at completely different
 *    actions.
 *  - **Every problem at once.** A broken configuration has one actor and one recovery (fix
 *    it, restart), so it is one error; but it has to say everything, or each fix costs
 *    another restart.
 */
import { z } from 'zod'

const EnvSchema = z.object({
  MODEL_BASE_URL: z.string().min(1),
  MODEL_API_KEY: z.string().min(1),
  MODEL_ID: z.string().min(1),
  /**
   * Model facts rather than deployment knobs, but there is no catalog to read them from
   * while exactly one model is configured. They move to wherever that catalog lives the day
   * a second model does.
   */
  MODEL_CONTEXT_WINDOW: z.coerce.number().int().positive(),
  MODEL_MAX_TOKENS: z.coerce.number().int().positive(),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  OBJECTS_BUCKET: z.string().min(1),
  OBJECTS_ENDPOINT: z.string().min(1),
  OBJECTS_ACCESS_KEY: z.string().min(1),
  OBJECTS_SECRET_KEY: z.string().min(1),
  OBJECTS_REGION: z.string().default('us-east-1'),

  SANDBOX_IMAGE: z.string().min(1),

  /**
   * Reaches skill scripts as an environment variable inside the sandbox, and is the only
   * way they can spend money. The agent is never told it exists (architecture.md §8).
   */
  GATEWAY_URL: z.string().min(1),

  /**
   * Names this process within the consumer group. Defaults to the hostname, which is what
   * a container orchestrator already makes unique; two processes sharing one would each see
   * a fraction of the work with nothing saying so.
   */
  AGENT_NAME: z.string().default(Bun.env['HOSTNAME'] ?? 'agent'),
})

export type Env = z.infer<typeof EnvSchema>

export const readEnv = (
  source: Readonly<Record<string, string | undefined>> = process.env,
): Env => {
  const present: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') present[name] = value
  }

  const parsed = EnvSchema.safeParse(present)
  if (parsed.success) return parsed.data

  throw new Error(`configuration is not usable:\n${describe(parsed.error)}`)
}

const describe = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .sort()
    .join('\n')
