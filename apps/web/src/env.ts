import { z } from 'zod'

const Configuration = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  API_URL: z.url().default('http://localhost:8787'),
  WEB_USER: z.string().min(1).default('dev'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
})

export const readEnv = (
  source: Readonly<Record<string, string | undefined>> = process.env,
): z.infer<typeof Configuration> => {
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  )

  const parsed = Configuration.safeParse(present)
  if (parsed.success) return parsed.data

  throw new Error(
    `configuration is not usable:\n${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')}`,
  )
}
