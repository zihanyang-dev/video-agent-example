import { z } from 'zod'

/** Process schemas define parsing/defaults, not OS-level secret isolation.
 * Deployment must select which variables each process receives before startup.
 */
type EnvSource = Readonly<Record<string, string | undefined>>

const requiredString = z.string({ error: 'Required nonblank value' }).min(1)
const httpUrl = z.url({
  protocol: /^https?$/,
  error: 'Must be an HTTP(S) URL',
})
const databaseUrl = z.url({
  protocol: /^postgres(?:ql)?$/,
  error: 'Must be a PostgreSQL URL',
})
const redisUrl = z.url({
  protocol: /^rediss?$/,
  error: 'Must be a Redis URL',
})
const positiveInteger = z.coerce
  .number({ error: 'Must be a positive integer' })
  .int({ error: 'Must be a positive integer' })
  .positive({ error: 'Must be a positive integer' })
const port = positiveInteger.max(65535, { error: 'Must be at most 65535' })
const turnTokenSecret = requiredString.min(32, {
  error: 'Must contain at least 32 characters',
})

export const serverEnvSchema = z.object({
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  PORT: port.default(8787),
})

export const workerEnvSchema = z
  .object({
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    MODEL_BASE_URL: httpUrl,
    MODEL_API_KEY: requiredString,
    MODEL_ID: requiredString,
    EGRESS_URL: httpUrl,
    SANDBOX_IMAGE: requiredString,
    SANDBOX_NETWORK: requiredString,
    TURN_TOKEN_SECRET: turnTokenSecret,
    LEASE_MS: positiveInteger.default(30000),
    POLL_MS: positiveInteger.default(200),
    CONCURRENCY: positiveInteger.default(3),
  })
  // Reserve three polling intervals for renewal; this is not a guarantee against pauses.
  .refine((env) => env.LEASE_MS > 3 * env.POLL_MS, {
    path: ['LEASE_MS'],
    message: 'Must exceed three polling intervals (POLL_MS)',
  })

export const egressEnvSchema = z.object({
  FAL_KEY: requiredString.optional(),
  TURN_TOKEN_SECRET: turnTokenSecret,
  PORT: port.default(8080),
  PROVIDER_ROUTES_PATH: requiredString.default('/app/config/providers.json'),
})

export const migrationEnvSchema = z.object({
  DATABASE_URL: databaseUrl,
})

export type ServerEnv = z.infer<typeof serverEnvSchema>
export type WorkerEnv = z.infer<typeof workerEnvSchema>
export type EgressEnv = z.infer<typeof egressEnvSchema>
export type MigrationEnv = z.infer<typeof migrationEnvSchema>

function readEnv<Schema extends z.ZodType>(
  schema: Schema,
  source: EnvSource,
): z.output<Schema> {
  // Omit blank entries without altering nonblank credentials.
  const nonblankEntries = Object.entries(source).filter(
    ([, entry]) => entry !== undefined && entry.trim() !== '',
  )
  const parsed = schema.safeParse(Object.fromEntries(nonblankEntries))
  if (parsed.success) return parsed.data

  // Only schema-owned messages are exposed, never Zod's input or full error.
  const diagnostics = parsed.error.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`,
  )
  throw new Error(
    `Invalid environment configuration:\n${diagnostics.join('\n')}`,
  )
}

/** Parse product-process input once; return no model or tool-provider credentials. */
export function readServerEnv(source: EnvSource = process.env): ServerEnv {
  return readEnv(serverEnvSchema, source)
}

/** Parse trusted execution input; tool-provider keys belong to egress instead. */
export function readWorkerEnv(source: EnvSource = process.env): WorkerEnv {
  return readEnv(workerEnvSchema, source)
}

/** Parse proxy-private credentials and verification settings, not execution settings. */
export function readEgressEnv(source: EnvSource = process.env): EgressEnv {
  return readEnv(egressEnvSchema, source)
}

/** Parse only the migration connection; this does not create or select a database. */
export function readMigrationEnv(
  source: EnvSource = process.env,
): MigrationEnv {
  return readEnv(migrationEnvSchema, source)
}
