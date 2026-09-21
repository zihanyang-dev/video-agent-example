/**
 * The only file in this process that reads `process.env`.
 *
 * Blank means unset, and every problem is reported at once: a broken configuration has one
 * actor and one recovery, but it has to say everything or each fix costs another restart
 * (code-style §4.6).
 */
import { z } from 'zod'
import { Providers } from './providers/providers'

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  /**
   * Shared with the agent that issues sandbox tokens. This authenticates the request and
   * attributes it to a turn; it does not enforce a spending limit or billing entitlement.
   */
  TURN_TOKEN_SECRET: z.string().min(32),
  PROVIDERS: z.string().transform((raw, ctx) => {
    const parsed = Providers.safeParse(safeJson(raw))
    if (parsed.success) return parsed.data

    ctx.addIssue({ code: 'custom', message: `not a provider table: ${parsed.error.message}` })
    return z.NEVER
  }),
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

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    // Malformed JSON and invalid provider fields share the configuration-error recovery.
    return null
  }
}
