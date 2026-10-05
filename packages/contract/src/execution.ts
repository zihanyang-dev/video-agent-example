import { z } from 'zod'

const file = {
  objectKey: z.string().min(1).max(1024),
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^(?!\.{1,2}$)(?!.*[/\\])[\x20-\x7e\u0080-\uffff]+$/),
  mimeType: z
    .string()
    .max(127)
    .regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/),
  byteLength: z
    .number()
    .int()
    .nonnegative()
    .max(1024 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}
export const assetReferenceSchema = z
  .strictObject({ assetID: z.uuid().toLowerCase(), ...file })
  .readonly()
export type AssetReference = z.infer<typeof assetReferenceSchema>

export const ASSET_MAX_INPUT_FILES = 16
export const ASSET_MAX_OUTPUT_FILES = 32

const startInputSchema = z
  .strictObject({
    messageID: z.uuid().toLowerCase(),
    text: z.string(),
    assets: z
      .array(assetReferenceSchema)
      .min(1)
      .max(ASSET_MAX_INPUT_FILES)
      .readonly()
      .optional(),
  })
  .refine(
    (input) => input.text.trim().length > 0 || input.assets !== undefined,
    { error: 'Message text must not be blank' },
  )
  .readonly()

/**
 * Internal server-to-agent commands, separate from public AG-UI events and run state.
 * The server supplies accepted input and stable identities; receivers deduplicate by
 * commandID, not Redis entry ID. Parsing canonicalizes UUIDs and preserves text; submission owns text normalization.
 */
export const startCommandSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal('start'),
    commandID: z.uuid().toLowerCase(),
    threadID: z.uuid().toLowerCase(),
    runID: z.uuid().toLowerCase(),
    input: startInputSchema,
  })
  .readonly()

/** Requests cancellation; it is not a claim that the run has already stopped. */
export const cancelCommandSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal('cancel'),
    commandID: z.uuid().toLowerCase(),
    threadID: z.uuid().toLowerCase(),
    runID: z.uuid().toLowerCase(),
  })
  .readonly()

export const executionCommandSchema = z.discriminatedUnion('kind', [
  startCommandSchema,
  cancelCommandSchema,
])

export type StartCommand = z.infer<typeof startCommandSchema>
export type CancelCommand = z.infer<typeof cancelCommandSchema>
export type ExecutionCommand = z.infer<typeof executionCommandSchema>

const identities = {
  version: z.literal(1),
  eventID: z.uuid().toLowerCase(),
  threadID: z.uuid().toLowerCase(),
  runID: z.uuid().toLowerCase(),
}

/** Facts for server acceptance. Object keys are private allocation references, never client URLs.
 * Private history, tool arguments and errors never travel here. */
export const executionEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...identities, kind: z.literal('run-started') }).readonly(),
  z
    .strictObject({
      ...identities,
      kind: z.literal('assistant-text'),
      messageID: z.uuid().toLowerCase(),
      delta: z.string(),
    })
    .readonly(),
  z
    .strictObject({
      ...identities,
      kind: z.literal('run-completed'),
      messageID: z.uuid().toLowerCase(),
      text: z.string(),
      assets: z
        .array(assetReferenceSchema)
        .max(ASSET_MAX_OUTPUT_FILES)
        .readonly()
        .optional(),
    })
    .readonly(),
  z
    .strictObject({ ...identities, kind: z.literal('run-cancelled') })
    .readonly(),
  z
    .strictObject({
      ...identities,
      kind: z.literal('run-failed'),
      reason: z.enum([
        'execution-error',
        'interrupted',
        'sandbox-recovery-required',
      ]),
    })
    .readonly(),
])

export type ExecutionEvent = z.infer<typeof executionEventSchema>

/** Ordering belongs to the durable run outbox, not Redis entry IDs or arrival time. */
export const executionDeliverySchema = z
  .strictObject({
    ordinal: z.number().int().positive(),
    event: executionEventSchema,
  })
  .readonly()

export type ExecutionDelivery = z.infer<typeof executionDeliverySchema>

/** Native schema export for foreign wire validators, never fake HTTP routes.
 * UUID parsing additionally canonicalizes case; validators do not insert or
 * normalize values. ECMAScript patterns and UTF-16 length checks remain runtime
 * semantics when another language's regex/string model differs. */
export function executionJSONSchemas() {
  const options: z.core.ToJSONSchemaParams = {
    target: 'draft-2020-12',
    io: 'input',
    override: ({ zodSchema, jsonSchema }) => {
      delete jsonSchema.readOnly
      if (zodSchema === startInputSchema) {
        jsonSchema.anyOf = [
          {
            type: 'object',
            properties: { text: { type: 'string', pattern: '\\S' } },
            required: ['text'],
          },
          {
            type: 'object',
            properties: { assets: { type: 'array' } },
            required: ['assets'],
          },
        ]
      }
    },
  }
  return {
    command: {
      ...z.toJSONSchema(executionCommandSchema, options),
      $id: 'urn:vid:execution:command:v1',
    },
    delivery: {
      ...z.toJSONSchema(executionDeliverySchema, options),
      $id: 'urn:vid:execution:delivery:v1',
    },
  }
}

/** Cross-process wire names. No trimming: durable owners decide retention. */
export const executionStreams = {
  commands: 'vid:execution:commands',
  events: 'vid:execution:events',
  commandGroup: 'execution-workers',
  eventGroup: 'product-servers',
} as const
