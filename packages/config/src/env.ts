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
const redisUrl = z
  .url({
    protocol: /^rediss?$/,
    error: 'Must be a Redis URL',
  })
  .refine(
    (value) => {
      try {
        const { pathname } = new URL(value)
        if (pathname === '' || pathname === '/') {
          return true
        }
        return /^\/\d+$/.test(pathname)
      } catch {
        return false
      }
    },
    { error: 'Must specify a nonnegative integer Redis database path' },
  )
const positiveInteger = z.coerce
  .number({ error: 'Must be a positive integer' })
  .int({ error: 'Must be a positive integer' })
  .positive({ error: 'Must be a positive integer' })
const port = positiveInteger.max(65535, { error: 'Must be at most 65535' })

export const assetBudgetDefaults = {
  ASSET_MAX_BYTES: 8388608,
  ASSET_MAX_FILES: 16,
  FILE_IO_TIMEOUT_MS: 30000,
} as const
const objectStorage = {
  OBJECT_STORAGE_URL: httpUrl,
  OBJECT_STORAGE_REGION: requiredString,
  OBJECT_STORAGE_BUCKET: requiredString,
  OBJECT_STORAGE_ACCESS_KEY_ID: requiredString,
  OBJECT_STORAGE_SECRET_ACCESS_KEY: requiredString,
  ASSET_MAX_BYTES: positiveInteger
    .max(16777216)
    .default(assetBudgetDefaults.ASSET_MAX_BYTES),
  ASSET_MAX_FILES: positiveInteger
    .max(32)
    .default(assetBudgetDefaults.ASSET_MAX_FILES),
  FILE_IO_TIMEOUT_MS: positiveInteger
    .min(1000)
    .max(120000)
    .default(assetBudgetDefaults.FILE_IO_TIMEOUT_MS),
}

export const serverEnvSchema = z.object({
  ...objectStorage,
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  PORT: port.default(8787),
  AUTH_BASE_URL: httpUrl.refine(
    (origin) => {
      try {
        const url = new URL(origin)
        return (
          url.origin === origin &&
          (url.protocol === 'https:' ||
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        )
      } catch {
        // Zod can continue refinements after a URL-format failure. Keep the
        // rejection in its safe, aggregated diagnostics rather than throwing.
        return false
      }
    },
    {
      error: 'Must be a canonical origin without path, query, or credentials',
    },
  ),
  AUTH_SECRET: requiredString.min(32, {
    error: 'Must contain at least 32 characters',
  }),
  GITHUB_CLIENT_ID: requiredString,
  GITHUB_CLIENT_SECRET: requiredString,
  IO_TIMEOUT_MS: positiveInteger.min(1000).max(60000).default(5000),
  POLL_MS: positiveInteger.max(10000).default(200),
})

export const workerEnvSchema = z
  .object({
    ...objectStorage,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    MODEL_BASE_URL: httpUrl,
    MODEL_API_KEY: requiredString,
    MODEL_ID: requiredString,
    MODEL_PROMPT_PATH: requiredString.default(
      '/app/profiles/video/instructions.md',
    ),
    // Custom endpoints must declare limits; do not fabricate model-registry metadata.
    MODEL_CONTEXT_WINDOW: positiveInteger,
    MODEL_MAX_OUTPUT_TOKENS: positiveInteger,
    MODEL_REASONING: z
      .enum(['true', 'false'])
      .transform((setting) => setting === 'true')
      .default(false),
    MODEL_INPUT: z.enum(['text', 'text,image']).default('text'),
    E2B_API_URL: httpUrl,
    E2B_API_KEY: requiredString,
    E2B_SANDBOX_URL: httpUrl,
    E2B_TEMPLATE: requiredString.default('base'),
    SANDBOX_PROVIDER: z.literal('e2b').default('e2b'),
    SANDBOX_TIMEOUT_MS: positiveInteger.max(3600000).default(300000),
    LEASE_MS: positiveInteger.default(30000),
    POLL_MS: positiveInteger.default(200),
    CONCURRENCY: positiveInteger.default(3),
    IO_TIMEOUT_MS: positiveInteger.min(1000).max(60000).default(5000),
  })
  // Reserve three polling intervals for renewal; this is not a guarantee against pauses.
  .refine((env) => env.LEASE_MS > 3 * env.POLL_MS, {
    path: ['LEASE_MS'],
    message: 'Must exceed three polling intervals (POLL_MS)',
  })
  .refine((env) => env.MODEL_MAX_OUTPUT_TOKENS < env.MODEL_CONTEXT_WINDOW, {
    path: ['MODEL_MAX_OUTPUT_TOKENS'],
    message: 'Must leave space for input within MODEL_CONTEXT_WINDOW',
  })

export const migrationEnvSchema = z.object({
  DATABASE_URL: databaseUrl,
})

export type ServerEnv = z.infer<typeof serverEnvSchema>
export type WorkerEnv = z.infer<typeof workerEnvSchema>
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

/** Parse trusted execution input; no unconsumed provider credentials are required. */
export function readWorkerEnv(source: EnvSource = process.env): WorkerEnv {
  return readEnv(workerEnvSchema, source)
}

/** Parse only the migration connection; this does not create or select a database. */
export function readMigrationEnv(
  source: EnvSource = process.env,
): MigrationEnv {
  return readEnv(migrationEnvSchema, source)
}
