import { z } from 'zod'
import { assetReferenceSchema } from './execution'
import { webSourcesSchema } from './web-source'

export const CONVERSATION_CONTEXT_MAX_BYTES = 1024 * 1024

const messageFields = {
  messageID: z.uuid().toLowerCase(),
  text: z.string(),
}
const assetsSchema = z.array(assetReferenceSchema).readonly().optional()
const inputSchema = z.strictObject({ ...messageFields, assets: assetsSchema }).readonly()
const outputSchema = z
  .strictObject({ ...messageFields, sources: webSourcesSchema.optional(), assets: assetsSchema })
  .readonly()
const turnSchema = z
  .strictObject({ runID: z.uuid().toLowerCase(), input: inputSchema, output: outputSchema })
  .readonly()

/** Completed business facts, not SDK state or a model prompt format. */
export const conversationContextSchema = z
  .strictObject({
    version: z.literal(1),
    throughRunID: z.uuid().toLowerCase().nullable(),
    turns: z.array(turnSchema).readonly(),
  })
  .superRefine((context, ctx) => {
    if (context.throughRunID !== (context.turns.at(-1)?.runID ?? null))
      ctx.addIssue({ code: 'custom', message: 'Conversation context cutoff mismatch' })

    const runs = context.turns.map((turn) => turn.runID)
    if (new Set(runs).size !== runs.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate context run identity' })
    const messages = context.turns.flatMap((turn) => [turn.input.messageID, turn.output.messageID])
    if (new Set(messages).size !== messages.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate context message identity' })

    if (
      new TextEncoder().encode(JSON.stringify(context)).byteLength > CONVERSATION_CONTEXT_MAX_BYTES
    )
      ctx.addIssue({ code: 'custom', message: 'Conversation context exceeds UTF8 material limit' })
  })
  .readonly()

export type ConversationContext = z.infer<typeof conversationContextSchema>
