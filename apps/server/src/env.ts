/**
 * The only file in this process that reads `process.env`.
 *
 * Blank means unset, and every problem is reported at once: a broken configuration has one
 * actor and one recovery, but it has to say everything or each fix costs another restart
 * (code-style §4.6).
 */
import { z } from 'zod'

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
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

  throw new Error(
    `configuration is not usable:\n${parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .sort()
      .join('\n')}`,
  )
}
