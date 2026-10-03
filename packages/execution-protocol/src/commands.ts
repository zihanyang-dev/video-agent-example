import { z } from 'zod'

/**
 * Internal server-to-agent commands, separate from public AG-UI events and run state.
 * The server supplies accepted input and stable identities; receivers deduplicate by
 * commandID, not Redis entry ID. Parsing preserves text; submission owns normalization.
 */
export const startCommandSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal('start'),
    commandID: z.uuid(),
    threadID: z.uuid(),
    runID: z.uuid(),
    input: z
      .strictObject({
        messageID: z.uuid(),
        text: z.string().refine((text) => text.trim().length > 0, {
          error: 'Message text must not be blank',
        }),
      })
      .readonly(),
  })
  .readonly()

/** Requests cancellation; it is not a claim that the run has already stopped. */
export const cancelCommandSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal('cancel'),
    commandID: z.uuid(),
    threadID: z.uuid(),
    runID: z.uuid(),
  })
  .readonly()

export const executionCommandSchema = z.discriminatedUnion('kind', [
  startCommandSchema,
  cancelCommandSchema,
])

export type StartCommand = z.infer<typeof startCommandSchema>
export type CancelCommand = z.infer<typeof cancelCommandSchema>
export type ExecutionCommand = z.infer<typeof executionCommandSchema>
