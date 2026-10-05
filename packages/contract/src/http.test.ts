import { expect, test } from 'bun:test'
import Ajv from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import {
  publicJSONSchemas,
  messageAcceptedSchema,
  cancellationAcceptedSchema,
  publicAssetSchema,
  messageSubmissionSchema,
  threadCreationSchema,
  threadResponseSchema,
  messagesResponseSchema,
  sessionResponseSchema,
} from './http'

const id = 'A4C9C419-1C7F-4F87-863D-4261C6089985'

test('public creation canonicalizes retry identity and trims the thread title', () => {
  expect(
    threadCreationSchema.parse({ threadID: id, title: '  Film  ' }),
  ).toEqual({
    threadID: id.toLowerCase(),
    title: 'Film',
  })
})

test('public requests cannot supply an authenticated actor or ownership', () => {
  expect(
    threadCreationSchema.safeParse({
      threadID: id,
      title: 'Film',
      ownerID: 'attacker',
    }).success,
  ).toBe(false)
  expect(
    messageSubmissionSchema.safeParse({
      messageID: id,
      text: 'Hello',
      role: 'owner',
    }).success,
  ).toBe(false)
})

test('an asset-only message is input, but an empty message is not', () => {
  expect(
    messageSubmissionSchema.safeParse({
      messageID: id,
      text: '',
      assetIDs: [id],
    }).success,
  ).toBe(true)
  expect(
    messageSubmissionSchema.safeParse({ messageID: id, text: '  ' }).success,
  ).toBe(false)
})

test('an asset reference occurs once and never expands beyond the message budget', () => {
  expect(
    messageSubmissionSchema.safeParse({
      messageID: id,
      text: 'Hello',
      assetIDs: [id, id.toLowerCase()],
    }).success,
  ).toBe(false)
  expect(
    messageSubmissionSchema.safeParse({
      messageID: id,
      text: 'Hello',
      assetIDs: Array.from({ length: 17 }, () => crypto.randomUUID()),
    }).success,
  ).toBe(false)
})

test('public snapshots expose thread ownership and active execution without SDK session secrets', () => {
  expect(
    threadResponseSchema.safeParse({
      thread: {
        threadID: id,
        title: 'Film',
        createdAt: '2026-10-04T00:00:00.000Z',
        archivedAt: null,
      },
    }).success,
  ).toBe(true)
  expect(
    messagesResponseSchema.parse({
      messages: [
        {
          messageID: id,
          role: 'user',
          text: 'Hello',
          createdAt: '2026-10-04T00:00:00.000Z',
        },
      ],
      activeRuns: [{ runID: id, messageID: id, status: 'stopping' }],
      failedRuns: [],
    }).activeRuns[0]?.status,
  ).toBe('stopping')
  expect(
    sessionResponseSchema.safeParse({
      user: {
        userID: 'Opaque-ID',
        name: 'Test',
        email: 'test@example.com',
        image: null,
        token: 'secret',
      },
    }).success,
  ).toBe(false)
})

test('public file DTOs reject private allocation authority and accepted results retain stable IDs', () => {
  const accepted = { messageID: id, commandID: id, runID: id }
  expect(messageAcceptedSchema.parse(accepted)).toEqual({
    messageID: id.toLowerCase(),
    commandID: id.toLowerCase(),
    runID: id.toLowerCase(),
  })
  expect(
    cancellationAcceptedSchema.parse({ commandID: id, runID: id }).runID,
  ).toBe(id.toLowerCase())
  expect(
    publicAssetSchema.safeParse({
      assetID: id,
      name: 'file.txt',
      mimeType: 'text/plain',
      byteLength: 1,
      createdAt: '2026-10-04T00:00:00.000Z',
      objectKey: 'private',
    }).success,
  ).toBe(false)
  expect(
    messageSubmissionSchema.safeParse({
      messageID: id,
      text: 'test',
      assets: [{ objectKey: 'private', sha256: 'fake', mimeType: 'image/png' }],
    }).success,
  ).toBe(false)
})

test('native JSON Schema input accepts trim-aware titles and preserves default direction', () => {
  const ajv = new Ajv({ strict: false })
  addFormats(ajv)
  const schemas = publicJSONSchemas()
  const creation = ajv.compile(schemas.ThreadCreationInput!)
  const padded = { threadID: id, title: ` ${'x'.repeat(160)} ` }
  expect(threadCreationSchema.safeParse(padded).success).toBe(true)
  expect(creation(padded)).toBe(true)
  expect(creation({ threadID: id, title: ' '.repeat(200) })).toBe(false)
  expect(creation({ threadID: id, title: 'x'.repeat(161) })).toBe(false)
  const submission = ajv.compile(schemas.MessageSubmissionInput!)
  expect(submission({ messageID: id, text: 'hello' })).toBe(true)
  expect(submission({ messageID: id, text: '  ' })).toBe(false)
  expect(submission({ messageID: id, text: '', assetIDs: [id] })).toBe(true)
  const output = ajv.compile(schemas.MessageSubmission!)
  expect(output({ messageID: id, text: 'hello' })).toBe(false)
})

test('generated cross-language document resolves every local reference and validates public response shapes', async () => {
  const specification: Record<string, unknown> = await Bun.file(
    new URL('../generated/openapi.json', import.meta.url),
  ).json()
  const ajv = new Ajv({ strict: false })
  addFormats(ajv)
  ajv.addSchema(specification, 'public')
  const response = ajv.getSchema('public#/components/schemas/ThreadResponse')
  if (!response) throw new Error('Missing generated response schema')
  expect(
    response({
      thread: {
        threadID: id.toLowerCase(),
        title: 'Film',
        createdAt: '2026-10-04T00:00:00.000Z',
        archivedAt: null,
      },
    }),
  ).toBe(true)
  expect(response({ thread: { threadID: id, title: 'Film' } })).toBe(false)
  for (const reference of schemaReferences(specification)) {
    expect(reference.startsWith('#/')).toBe(true)
    expect(ajv.getSchema(`public${reference}`)).toBeDefined()
  }
})

function schemaReferences(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) =>
    key === '$ref' && typeof child === 'string'
      ? [child]
      : schemaReferences(child),
  )
}

test.each(['../secret', '\u0000secret', 'line\n.txt', '.', '..'])(
  'public file metadata rejects the same unsafe name %j as the byte boundary',
  (name) => {
    expect(
      publicAssetSchema.safeParse({
        assetID: id,
        source: 'upload',
        name,
        mimeType: 'text/plain',
        byteLength: 1,
        createdAt: '2026-10-04T00:00:00.000Z',
      }).success,
    ).toBe(false)
  },
)

test('message snapshots expose only public-safe failure reasons with accepted message identity', () => {
  const snapshot = {
    messages: [],
    activeRuns: [],
    failedRuns: [{ runID: id, messageID: id, reason: 'interrupted' }],
  }
  expect(messagesResponseSchema.safeParse(snapshot).success).toBe(true)
  const ajv = new Ajv({ strict: false })
  addFormats(ajv)
  const validate = ajv.compile(publicJSONSchemas().MessagesResponse!)
  expect(validate(snapshot)).toBe(true)
  for (const reason of ['private diagnostic', 'sandbox-token=secret']) {
    const unsafe = {
      ...snapshot,
      failedRuns: [{ runID: id, messageID: id, reason }],
    }
    expect(messagesResponseSchema.safeParse(unsafe).success).toBe(false)
    expect(validate(unsafe)).toBe(false)
  }
})
