/**
 * Durable messages exchanged by the server and agent through their outboxes.
 *
 * Schemas describe what crosses the process boundary. Acceptance, execution ownership and
 * public presentation remain with their applications; receiving a command is not evidence
 * that a run has started or that an external operation succeeded.
 */
import { z } from 'zod'
import { AskContent, PlanContent, StepContent } from '../public/activity'

const CommandIdentity = {
  commandID: z.string().min(1),
  threadID: z.string().min(1),
}

export const ExecutionCommand = z.discriminatedUnion('kind', [
  z.object({ ...CommandIdentity, kind: z.literal('message'), message: z.string().min(1) }),
  z.object({ ...CommandIdentity, kind: z.literal('stop'), turnID: z.string().min(1) }),
])

export type ExecutionCommand = z.infer<typeof ExecutionCommand>

// Text identity and channel travel together so both applications can restore open messages.
const TextIdentity = {
  messageID: z.string(),
  channel: z.enum(['assistant', 'reasoning']),
}

export const ExecutionProgress = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('started') }),
  z.object({
    kind: z.literal('finished'),
    outcome: z.enum(['succeeded', 'failed', 'cancelled', 'interrupted']),
    reason: z.string().nullable(),
  }),
  z.object({ kind: z.literal('text-start'), ...TextIdentity }),
  z.object({ kind: z.literal('text-delta'), ...TextIdentity, delta: z.string() }),
  z.object({ kind: z.literal('text-end'), ...TextIdentity }),
  z.object({ kind: z.literal('plan'), messageID: z.string(), ...PlanContent.shape }),
  z.object({ kind: z.literal('step'), messageID: z.string(), ...StepContent.shape }),
  z.object({ kind: z.literal('ask'), messageID: z.string(), ...AskContent.shape }),
  z.object({
    kind: z.literal('artifact'),
    messageID: z.string(),
    key: z.string(),
    role: z.enum(['preview', 'final']),
  }),
])

/**
 * eventID deduplicates transport redelivery; sequence orders the entire thread across
 * runs. Neither is the Redis entry ID nor the browser's independently assigned SSE cursor.
 */
export const ExecutionEvent = z.object({
  eventID: z.string().min(1),
  threadID: z.string().min(1),
  turnID: z.string().min(1),
  sequence: z.number().int().positive(),
  progress: ExecutionProgress,
})

export type ExecutionEvent = z.infer<typeof ExecutionEvent>
export type ExecutionProgress = z.infer<typeof ExecutionProgress>
