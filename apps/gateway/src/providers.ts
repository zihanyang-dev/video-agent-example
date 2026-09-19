/**
 * Where a request goes and what credential it carries.
 *
 * A configuration table, not a registry: adding a provider is a row here and a skill that
 * knows how to talk to it. There is no interface to implement and no code that understands
 * what any of them do -- this process forwards bytes it does not read (architecture.md §10).
 */
import { z } from 'zod'

export type Provider = {
  /** Where the path prefix points. */
  baseUrl: string
  /** Attached on the way out. Never leaves this process. */
  header: string
  key: string
  /**
   * Which models this deployment pays for. Omitted means any.
   *
   * Measured, not imagined: an agent read a parameter error as the model being unavailable,
   * picked a different one, and generated footage on it. Nothing refused, and the only
   * record was a sentence in a notes file. A skill cannot prevent this -- the agent can read
   * the script, so anything the script may do it may do directly -- which leaves here.
   */
  models?: readonly string[]
  /**
   * Origins this provider puts finished results on, such as
   * `https://ark-acg-cn-beijing.tos-cn-beijing.volces.com`.
   *
   * A generation answers with a link to a CDN, and the sandbox has no route to it -- that is
   * what `internal: true` on its network means. So the fetch comes back through here, and
   * this is the list of places it may fetch from, redirects included. Empty or absent means
   * nowhere: a gateway that fetched any URL it was handed would be an open proxy wearing our
   * credentials' network position.
   */
  results?: readonly string[]
}

/**
 * Providers arrive as one environment variable rather than a file, because a deploy already
 * knows how to keep a secret in an environment and does not know how to keep a file in one.
 *
 * ```
 * PROVIDERS={"seedance":{"baseUrl":"https://...","header":"Authorization","key":"Bearer ..."}}
 * ```
 */
export const Providers = z.record(
  z.string().min(1),
  z.object({
    baseUrl: z.string().min(1),
    header: z.string().min(1),
    key: z.string().min(1),
    models: z.array(z.string().min(1)).optional(),
    results: z.array(z.string().min(1)).optional(),
  }),
)

export type Providers = z.infer<typeof Providers>
