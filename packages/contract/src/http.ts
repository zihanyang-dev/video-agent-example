import { z } from 'zod'

export const publicUUIDSchema = z.uuid().toLowerCase()
const uuid = publicUUIDSchema

export const messageSubmissionSchema = z
  .strictObject({
    messageID: uuid,
    // Preserve text for exact replay; trimming here only tests for empty input.
    text: z.string().max(32768),
    assetIDs: z.array(uuid).max(16).default([]).meta({
      uniqueItems: true,
      description:
        'Unique after lowercase UUID canonicalization; case-insensitive equality is additionally enforced at runtime.',
    }),
  })
  .refine(
    (input) => input.text.trim().length > 0 || input.assetIDs.length > 0,
    { message: 'Provide text or at least one asset', path: ['text'] },
  )
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
const title = z.string().trim().min(1).max(160).meta({
  description:
    'Trimmed before validation: 1–160 UTF-16 code units after removing surrounding whitespace. Foreign validators may count Unicode code points instead.',
})
const timestamp = z.iso.datetime({ offset: true })
const userID = z.string().min(1)

export const threadCreationSchema = z.strictObject({ threadID: uuid, title })
export const threadUpdateSchema = z.strictObject({ title })
export const runCancellationSchema = z.strictObject({ commandID: uuid })

export const publicThreadSchema = z.strictObject({
  threadID: uuid,
  title,
  createdAt: timestamp,
  archivedAt: timestamp.nullable(),
})
export const publicFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^(?!\.{1,2}$)[^/\\]+$/)
  .refine(
    (name) =>
      name
        .split('')
        .every(
          (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
        ),
    'File names cannot contain ASCII controls',
  )
  .meta({
    // Native JSON Schema cannot infer the character-code refinement.
    pattern: '^(?!\\.{1,2}$)[^/\\\\\\u0000-\\u001f\\u007f]+$',
    description:
      'File name, not a path. Length is measured in UTF-16 code units at runtime; foreign validators may count Unicode code points.',
  })
const publicFile = {
  name: publicFileNameSchema,
  mimeType: z.string(),
  byteLength: z.number().int().nonnegative(),
  createdAt: timestamp,
}
export const publicAssetSchema = z.strictObject({
  assetID: uuid,
  source: z.enum(['upload', 'generated']),
  ...publicFile,
  messageID: uuid.optional(),
  runID: uuid.optional(),
})
export const assetResponseSchema = z.strictObject({ asset: publicAssetSchema })
export const assetsResponseSchema = z.strictObject({
  assets: z.array(publicAssetSchema),
})
export const publicMessageSchema = z.strictObject({
  messageID: uuid,
  role: z.enum(['user', 'assistant']),
  assets: z.array(publicAssetSchema).optional(),
  text: z.string(),
  createdAt: timestamp,
})
export const activeRunSchema = z.strictObject({
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
export const threadsResponseSchema = z.strictObject({
  threads: z.array(publicThreadSchema),
})
export const threadResponseSchema = z.strictObject({
  thread: publicThreadSchema,
})
export const failedRunSchema = z.strictObject({
  runID: uuid,
  messageID: uuid,
  reason: z.enum([
    'execution-error',
    'interrupted',
    'sandbox-recovery-required',
  ]),
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

export type {
  PublicThread,
  PublicMessage,
  ActiveRun,
  FailedRun,
  SessionResponse,
  ThreadsResponse,
  ThreadResponse,
  MessagesResponse,
  MessageAccepted,
  CancellationAccepted,
  PublicAsset,
  AssetResponse,
  AssetsResponse,
} from '../generated/client/types.gen'

export function publicJSONSchemas() {
  const schemas: Record<string, z.core.JSONSchema.BaseSchema> = {}
  for (const [name, schema] of Object.entries(publicSchemas)) {
    schemas[name] = z.toJSONSchema(schema, {
      io: 'output',
      target: 'draft-2020-12',
    })
    schemas[`${name}Input`] = z.toJSONSchema(schema, {
      io: 'input',
      target: 'draft-2020-12',
      override: (context) => {
        if (context.zodSchema !== title) return
        delete context.jsonSchema.minLength
        delete context.jsonSchema.maxLength
        context.jsonSchema.pattern = '^\\s*\\S(?:[\\s\\S]{0,158}\\S)?\\s*$'
      },
    })
  }
  return schemas
}
