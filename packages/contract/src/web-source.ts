import { z } from 'zod'

export const WEB_SOURCES_PER_SEARCH = 5
export const WEB_SOURCES_PER_TURN = 15

// Citation admission only: no DNS lookup or fetching, and no claim that a DNS
// name resolves to a public network. Deliberately narrower than a generic URL.
// Queries with percent escapes are excluded to keep credential-key checks
// identical in native validation and foreign JSON Schema validators.
const citationPattern =
  /^https:\/\/(?!(?:[^/?#]*\.)?(?:localhost|local|internal|lan|home|test|invalid|localdomain|intranet|corp|onion)(?:[/?#]|$))(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/(?![^?#]*%(?:0[0-9a-fA-F]|1[0-9a-fA-F]|7[fF]|[cC]2%[89][0-9a-fA-F]))[^\s<>\\?#\p{Cc}\p{Cf}\ud800-\udfff]*)?(?:\?(?![^#]*(?:key|token|secret|password|credential|signature|authorization|auth|session|jwt|sig))[a-z0-9&=_.~+/-]*)?$/u

const webSourceURLSchema = z
  .string()
  .max(2048)
  .regex(citationPattern)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        url.protocol === 'https:' && !url.username && !url.password && !url.hash
      )
    } catch {
      return false
    }
  })

export const webSourceSchema = z
  .strictObject({
    title: z
      .string()
      .min(1)
      .max(256)
      .regex(
        // oxlint-disable-next-line no-control-regex -- plain public titles, including PostgreSQL-safe Unicode.
        /^(?=.*\S)[^<>\p{Cc}\p{Cf}\ud800-\udfff]*$/u,
      ),
    url: webSourceURLSchema,
  })
  .readonly()

export const webSourcesSchema = z
  .array(webSourceSchema)
  .max(WEB_SOURCES_PER_TURN)
  .readonly()
export type WebSource = z.infer<typeof webSourceSchema>

/** Normalize only admitted facts; native URL serialization can expand Unicode
 * paths beyond the input limit. Never resolve or fetch a citation. */
export function normalizeWebSource(value: unknown): WebSource | undefined {
  const input = webSourceSchema.safeParse(value)
  if (!input.success) return
  const normalized = webSourceSchema.safeParse({
    title: input.data.title,
    url: new URL(input.data.url).href,
  })
  return normalized.success ? normalized.data : undefined
}
