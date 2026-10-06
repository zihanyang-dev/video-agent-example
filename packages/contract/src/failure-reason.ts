import { z } from 'zod'

/** Closed public recovery categories, never provider diagnostics. */
export const publicFailureReasonSchema = z.enum([
  'execution-error',
  'interrupted',
  'sandbox-recovery-required',
])
