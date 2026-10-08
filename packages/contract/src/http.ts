import { z } from 'zod'
import { webSourcesSchema } from './web-source'
import { fileNameSchema } from './file-name'
import { publicFailureReasonSchema } from './failure-reason'
import { ASSET_MAX_INPUT_FILES } from './asset-limits'
import { productTextSchema as productText } from './product-text'

export const publicUUIDSchema = z.uuid().toLowerCase()
const uuid = publicUUIDSchema

export const messageSubmissionSchema = z
  .strictObject({
    messageID: uuid,
    // Preserve text for exact replay; trimming here only tests for empty input.
    text: productText.max(32768),
    assetIDs: z.array(uuid).max(ASSET_MAX_INPUT_FILES).default([]).meta({
      uniqueItems: true,
      description:
        'Unique after lowercase UUID canonicalization; case-insensitive equality is additionally enforced at runtime.',
    }),
  })
  .refine((input) => input.text.trim().length > 0 || input.assetIDs.length > 0, {
    message: 'Provide text or at least one asset',
    path: ['text'],
  })
  .refine((input) => new Set(input.assetIDs).size === input.assetIDs.length, {
    message: 'Asset references must be unique',
    path: ['assetIDs'],
  })
  // JSON Schema cannot infer custom refinements. State the expressible rule
  // here beside its runtime check; canonical UUID equality remains documented.
  .meta({
    description:
      'Provide nonblank text or assets. UUID references are unique after lowercase canonicalization.',
    anyOf: [
      {
        properties: { text: { type: 'string', pattern: '\\S' } },
        required: ['text'],
      },
      {
        properties: { assetIDs: { type: 'array', minItems: 1 } },
        required: ['assetIDs'],
      },
    ],
  })

// JSON input permits surrounding whitespace; length applies after trim.
const title = productText.trim().min(1).max(160).meta({
  description:
    'Trimmed before validation: 1–160 UTF-16 code units after removing surrounding whitespace. Foreign validators may count Unicode code points instead.',
})
const timestamp = z.iso.datetime({ offset: true })
const userID = z.string().min(1)

export const threadCreationSchema = z.strictObject({ threadID: uuid, title })
export const threadUpdateSchema = z.strictObject({ title })
export const runCancellationSchema = z.strictObject({ commandID: uuid })

const publicThreadSchema = z.strictObject({
  threadID: uuid,
  title,
  createdAt: timestamp,
  archivedAt: timestamp.nullable(),
})
export const publicFileNameSchema = fileNameSchema
// Upload declarations and restored browser bytes share this exact MIME boundary.
// Byte signatures remain the server's authority; exports are not restricted here.
export const uploadMimeTypeSchema = z.enum([
  'text/plain',
  'application/json',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'audio/wav',
  'video/mp4',
  'application/pdf',
])
export type UploadMimeType = z.infer<typeof uploadMimeTypeSchema>
const publicFile = {
  name: publicFileNameSchema,
  mimeType: z.string(),
  byteLength: z.number().int().nonnegative(),
  createdAt: timestamp,
}
const publicAssetFields = { assetID: uuid, ...publicFile }
export const publicAssetSchema = z.discriminatedUnion('source', [
  z.strictObject({ ...publicAssetFields, source: z.literal('upload') }),
  z.strictObject({
    ...publicAssetFields,
    source: z.literal('generated'),
    messageID: uuid,
    runID: uuid,
  }),
])
export const assetResponseSchema = z.strictObject({ asset: publicAssetSchema })
const assetsResponseSchema = z.strictObject({
  assets: z.array(publicAssetSchema),
})
export const publicMessageSchema = z.strictObject({
  messageID: uuid,
  role: z.enum(['user', 'assistant']),
  assets: z.array(publicAssetSchema).optional(),
  text: z.string(),
  sources: webSourcesSchema.optional(),
  // Derived from the durable terminal receipt, never stream/disconnect state.
  runOutcome: z
    .strictObject({
      runID: uuid,
      status: z.enum(['completed', 'cancelled']),
    })
    .optional(),
  createdAt: timestamp,
})
const activeRunSchema = z.strictObject({
  runID: uuid,
  messageID: uuid,
  status: z.enum(['accepted', 'running', 'stopping']),
})
export const sessionResponseSchema = z.strictObject({
  user: z
    .strictObject({
      userID,
      name: z.string(),
      email: z.email(),
      image: z.string().nullable(),
    })
    .nullable(),
})
const threadsResponseSchema = z.strictObject({
  threads: z.array(publicThreadSchema),
})
export const threadResponseSchema = z.strictObject({
  thread: publicThreadSchema,
})
export const failedRunSchema = z.strictObject({
  runID: uuid,
  messageID: uuid,
  reason: publicFailureReasonSchema,
})
export const messagesResponseSchema = z.strictObject({
  messages: z.array(publicMessageSchema),
  activeRuns: z.array(activeRunSchema),
  failedRuns: z.array(failedRunSchema),
})

export const messageAcceptedSchema = z.strictObject({
  messageID: uuid,
  commandID: uuid,
  runID: uuid,
})
export const cancellationAcceptedSchema = z.strictObject({
  commandID: uuid,
  runID: uuid,
})

/** Native Zod conversion is deliberately strict: unrepresentable schemas fail
 * generation rather than silently replacing a public boundary with `any`. */
export const publicSchemas = {
  UUID: publicUUIDSchema,
  FileName: publicFileNameSchema,
  MessageSubmission: messageSubmissionSchema,
  ThreadCreation: threadCreationSchema,
  ThreadUpdate: threadUpdateSchema,
  RunCancellation: runCancellationSchema,
  PublicThread: publicThreadSchema,
  PublicAsset: publicAssetSchema,
  PublicMessage: publicMessageSchema,
  ActiveRun: activeRunSchema,
  FailedRun: failedRunSchema,
  SessionResponse: sessionResponseSchema,
  ThreadsResponse: threadsResponseSchema,
  ThreadResponse: threadResponseSchema,
  MessagesResponse: messagesResponseSchema,
  MessageAccepted: messageAcceptedSchema,
  CancellationAccepted: cancellationAcceptedSchema,
  AssetResponse: assetResponseSchema,
  AssetsResponse: assetsResponseSchema,
  EmptyRequest: z.strictObject({}),
  ErrorResponse: z.strictObject({ error: z.string() }),
}

export type PublicThread = z.output<typeof publicThreadSchema>
export type PublicMessage = z.output<typeof publicMessageSchema>
export type ActiveRun = z.output<typeof activeRunSchema>
export type SessionResponse = z.output<typeof sessionResponseSchema>
export type MessagesResponse = z.output<typeof messagesResponseSchema>
export type MessageAccepted = z.output<typeof messageAcceptedSchema>
export type CancellationAccepted = z.output<typeof cancellationAcceptedSchema>
export type PublicAsset = z.output<typeof publicAssetSchema>
export type AssetResponse = z.output<typeof assetResponseSchema>
export type AssetsResponse = z.output<typeof assetsResponseSchema>

const inboundSchemaNames = [
  'UUID',
  'EmptyRequest',
  'ThreadCreation',
  'ThreadUpdate',
  'MessageSubmission',
  'RunCancellation',
] as const satisfies readonly (keyof typeof publicSchemas)[]
const inboundNames: ReadonlySet<string> = new Set(inboundSchemaNames)
export type PublicSchemaName =
  keyof typeof publicSchemas | `${(typeof inboundSchemaNames)[number]}Input`

export function publicJSONSchemas() {
  const schemas: Record<string, z.core.JSONSchema.BaseSchema> = {}
  for (const [name, schema] of Object.entries(publicSchemas)) {
    schemas[name] = z.toJSONSchema(schema, {
      io: 'output',
      target: 'draft-2020-12',
    })
    if (!inboundNames.has(name)) continue
    schemas[`${name}Input`] = z.toJSONSchema(schema, {
      io: 'input',
      target: 'draft-2020-12',
      override: (context) => {
        if (context.zodSchema !== title) return
        delete context.jsonSchema.minLength
        delete context.jsonSchema.maxLength
        context.jsonSchema.allOf = [{ pattern: '^\\s*\\S(?:[\\s\\S]{0,158}\\S)?\\s*$' }]
      },
    })
  }
  return schemas
}
