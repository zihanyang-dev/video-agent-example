/**
 * Deployment configuration for credentialed forwarding and result downloads.
 *
 * Each provider names its upstream and credential header. Model names and result origins
 * constrain what the gateway forwards; provider-specific request construction remains with
 * the skill scripts that call it.
 */
import { z } from 'zod'

const Provider = z.object({
  baseUrl: z.string().min(1),
  /** Replaces the caller's credential on the outgoing request. */
  header: z.string().min(1),
  key: z.string().min(1),
  /**
   * A configured list rejects requests naming other models. The sandbox can bypass skill
   * scripts, so this restriction must run where the real provider credential is attached.
   * Omitted means unrestricted; requests without a model field still reach the provider.
   */
  models: z.array(z.string().min(1)).optional(),
  /**
   * Exact origins allowed for result downloads, including every redirect destination.
   * The scheme and port are part of an origin. An absent or empty list permits no downloads;
   * otherwise a sandbox could use the gateway's network access to reach arbitrary hosts.
   */
  results: z.array(z.string().min(1)).optional(),
})

/** The environment owns provider credentials, so configuration arrives as one JSON value. */
export const Providers = z.record(z.string().min(1), Provider)

export type Providers = z.infer<typeof Providers>
