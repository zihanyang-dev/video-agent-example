import {
  readBody,
  requestBodyRejection,
  type BodyCollectionPolicy,
} from './request-body'
import type { DB } from '@vid/database/types'
import type { Kysely } from 'kysely'
import { Hono, type Context } from 'hono'
import { describeRoute } from 'hono-openapi'
import {
  publicUUIDSchema,
  publicSchemas,
  uploadMimeTypeSchema,
  threadCreationSchema,
  threadUpdateSchema,
  type SessionResponse,
  type AssetsResponse,
} from '@vid/contract/http'
import {
  createAuthentication,
  readIdentity,
  signOut,
} from './identity/authentication'
import {
  listOwnedThreads,
  createOwnedThread,
  readOwnedThread,
  updateOwnedThread,
  snapshotOwnedMessages,
} from './db/conversations'
import { archiveThread } from './db/cancellations'
import {
  threadUnavailable,
  threadConflict,
  lockThread,
} from './db/thread-access'
import { listAssets } from './db/assets'
import { uploadAsset, downloadAsset } from './assets/http'
import type { FileHTTP } from './assets/uploads'
import {
  submitMessage,
  cancelObservation,
  openObservation,
  type ConversationOptions,
} from './conversation/http'

const unavailable = () => Response.json({ error: 'Not found' }, { status: 404 })
const invalid = () => Response.json({ error: 'Invalid input' }, { status: 400 })
const conflict = () => Response.json({ error: 'Conflict' }, { status: 409 })

export type HTTPResources = ConversationOptions & {
  db: Kysely<DB>
  bodyCollection: BodyCollectionPolicy
  maxAssetBytes: number
  files?: FileHTTP
  authentication: ReturnType<typeof createAuthentication>
}
type HTTPEnv = { Bindings: HTTPResources; Variables: { ownerID: string } }

const json = (name: string) => ({
  'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
})
const uuid = publicUUIDSchema
const fileContent = Object.fromEntries(
  uploadMimeTypeSchema.options.map((mimeType) => [
    mimeType,
    {
      schema: { type: 'string' as const, format: 'binary' },
    },
  ]),
)

/** Routes are defined without creating connections. Hono binds the server's
 * owned resources once per request; the offline generator only inspects routes. */
export function createRouter() {
  const app = new Hono<HTTPEnv>()
  app.onError((cause) => {
    const bodyRejection = requestBodyRejection(cause)
    if (bodyRejection) return bodyRejection
    if (cause === threadUnavailable) return unavailable()
    if (cause === threadConflict) return conflict()
    throw cause
  })
  app.notFound(unavailable)
  app.all('/api/auth/*', describeRoute({ hide: true }), (c) =>
    c.env.authentication.handler(c.req.raw),
  )
  app.post(
    '/api/logout',
    describeRoute({
      operationId: 'logout',
      requestBody: { required: true, content: json('EmptyRequestInput') },
      responses: {
        200: { description: 'Session durably revoked and SDK cookies expired' },
        403: { description: 'Untrusted origin' },
        408: { description: 'Request body timed out; retry same request' },
        413: { description: 'Request body exceeds byte limit' },
        415: { description: 'Expected JSON' },
        503: { description: 'Collection stopped or transport failed' },
      },
    }),
    (c) =>
      signOut(c.env.authentication, c.env.db, c.req.raw, c.env.bodyCollection),
  )
  app.all(
    '/api/logout',
    describeRoute({ hide: true }),
    () =>
      new Response('Method not allowed', {
        status: 405,
        headers: { Allow: 'POST' },
      }),
  )
  app.get(
    '/api/session',
    describeRoute({
      operationId: 'getSession',
      security: [],
      responses: {
        200: {
          description: 'Current identity',
          content: json('SessionResponse'),
        },
      },
    }),
    async (c) => {
      const user = await readIdentity(c.env.authentication, c.req.raw.headers)
      return Response.json({
        user: user
          ? {
              userID: user.id,
              name: user.name,
              email: user.email,
              image: user.image ?? null,
            }
          : null,
      } satisfies SessionResponse)
    },
  )
  app.use(
    '/api/*',
    describeRoute({
      security: [{ sessionCookie: [] }],
      responses: {
        400: { description: 'Invalid input' },
        401: { description: 'Authentication required' },
        403: { description: 'Untrusted origin' },
        404: { description: 'Not found (including foreign identifiers)' },
        408: { description: 'Request body timed out; retry same request' },
        409: { description: 'Conflicting intent or archived thread' },
        413: { description: 'Request body exceeds byte limit' },
        415: { description: 'Expected JSON request' },
        503: { description: 'Unavailable; retry after recovery' },
      },
    }),
    async (c, next) => {
      const user = await readIdentity(c.env.authentication, c.req.raw.headers)
      if (!user)
        return Response.json(
          { error: 'Authentication required' },
          { status: 401 },
        )
      c.set('ownerID', user.id)
      if (
        c.req.method !== 'GET' &&
        c.req.raw.headers.get('origin') !== c.env.authentication.options.baseURL
      )
        return new Response('Untrusted request origin', { status: 403 })
      return await next()
    },
  )
  app.get(
    '/api/threads',
    describeRoute({
      operationId: 'listThreads',
      responses: {
        200: { description: 'Owned threads', content: json('ThreadsResponse') },
      },
    }),
    async (c) =>
      Response.json({
        threads: await listOwnedThreads(c.env.db, c.get('ownerID')),
      }),
  )
  app.post(
    '/api/threads',
    describeRoute({
      operationId: 'createThread',
      requestBody: { required: true, content: json('ThreadCreationInput') },
      responses: {
        201: { description: 'Created', content: json('ThreadResponse') },
        200: { description: 'Exact replay', content: json('ThreadResponse') },
      },
    }),
    async (c) => {
      const rejection = requireJSON(c.req.raw)
      if (rejection) return rejection
      const input = threadCreationSchema.safeParse(
        await readBody(c.req.raw, c.env.bodyCollection),
      )
      if (!input.success) return invalid()
      const accepted = await createOwnedThread(c.env.db, {
        ...input.data,
        ownerID: c.get('ownerID'),
      })
      return Response.json(
        { thread: accepted.thread },
        { status: accepted.created ? 201 : 200 },
      )
    },
  )
  app.use(
    '/api/threads/:threadID/*',
    describeRoute({
      parameters: [
        {
          in: 'path',
          name: 'threadID',
          required: true,
          schema: { $ref: '#/components/schemas/UUIDInput' },
        },
      ],
    }),
  )
  app.get(
    '/api/threads/:threadID',
    describeRoute({
      operationId: 'getThread',
      responses: {
        200: { description: 'Owned thread', content: json('ThreadResponse') },
      },
    }),
    async (c) => {
      const query = ownedThread(c)
      if (!query) return invalid()
      const thread = await readOwnedThread(c.env.db, query)
      return thread ? Response.json({ thread }) : unavailable()
    },
  )
  app.patch(
    '/api/threads/:threadID',
    describeRoute({
      operationId: 'updateThread',
      requestBody: { required: true, content: json('ThreadUpdateInput') },
      responses: {
        200: { description: 'Updated', content: json('ThreadResponse') },
      },
    }),
    async (c) => {
      const rejection = requireJSON(c.req.raw)
      if (rejection) return rejection
      const query = ownedThread(c)
      const input = threadUpdateSchema.safeParse(
        await readBody(c.req.raw, c.env.bodyCollection),
      )
      if (!query || !input.success) return invalid()
      return Response.json({
        thread: await updateOwnedThread(c.env.db, { ...query, ...input.data }),
      })
    },
  )
  app.post(
    '/api/threads/:threadID/archive',
    describeRoute({
      operationId: 'archiveThread',
      requestBody: { required: true, content: json('EmptyRequestInput') },
      responses: {
        200: { description: 'Archived', content: json('ThreadResponse') },
      },
    }),
    async (c) => {
      const rejection = requireJSON(c.req.raw)
      if (rejection) return rejection
      const query = ownedThread(c)
      if (
        !query ||
        !publicSchemas.EmptyRequest.safeParse(
          await readBody(c.req.raw, c.env.bodyCollection),
        ).success
      )
        return invalid()
      return Response.json({ thread: await archiveThread(c.env.db, query) })
    },
  )
  app.get(
    '/api/threads/:threadID/messages',
    describeRoute({
      operationId: 'listMessages',
      responses: {
        200: {
          description: 'Public snapshot',
          content: json('MessagesResponse'),
        },
      },
    }),
    async (c) => {
      const query = ownedThread(c)
      if (!query) return invalid()
      const snapshot = await snapshotOwnedMessages(c.env.db, query)
      return snapshot ? Response.json(snapshot) : unavailable()
    },
  )
  app.post(
    '/api/threads/:threadID/messages',
    describeRoute({
      operationId: 'submitMessage',
      requestBody: { required: true, content: json('MessageSubmissionInput') },
      responses: {
        202: {
          description: 'Durably accepted',
          content: json('MessageAccepted'),
        },
      },
    }),
    async (c) => {
      const rejection = requireJSON(c.req.raw)
      if (rejection) return rejection
      const query = ownedThread(c)
      return query
        ? await submitMessage(
            c.env.db,
            query,
            await readBody(c.req.raw, c.env.bodyCollection),
            c.env.maxAssetBytes,
          )
        : invalid()
    },
  )
  app.use(
    '/api/threads/:threadID/runs/:runID/*',
    describeRoute({
      parameters: [
        {
          in: 'path',
          name: 'runID',
          required: true,
          schema: { $ref: '#/components/schemas/UUIDInput' },
        },
      ],
    }),
  )
  app.post(
    '/api/threads/:threadID/runs/:runID/cancel',
    describeRoute({
      operationId: 'cancelRun',
      requestBody: { required: true, content: json('RunCancellationInput') },
      responses: {
        202: {
          description: 'Durably accepted cancellation',
          content: json('CancellationAccepted'),
        },
      },
    }),
    async (c) => {
      const rejection = requireJSON(c.req.raw)
      if (rejection) return rejection
      const query = ownedRun(c)
      return query
        ? await cancelObservation(
            c.env.db,
            query,
            await readBody(c.req.raw, c.env.bodyCollection),
          )
        : invalid()
    },
  )
  app.post(
    '/api/threads/:threadID/runs/:runID/events',
    describeRoute({
      operationId: 'observeRun',
      externalDocs: {
        url: 'https://www.npmjs.com/package/@ag-ui/core/v/1.0.1',
        description: 'Official protocol schema package',
      },
      description:
        'Official AG-UI RunAgentInput (https://docs.ag-ui.com/sdk/js/core). Runtime validation uses the official SDK. JSON metadata cannot faithfully describe its custom values; no replacement DTO is generated. Cursor precedence: Last-Event-ID, forwardedProps.after, then 0. Cursors are decimal signed-int64 ordinals authorized against persisted public events.',
      requestBody: {
        required: true,
        description:
          'Official RunAgentInput: threadId and runId must be UUIDs matching the canonical path identifiers. Submitted history, state, context and tools never initiate new execution.',
        content: { 'application/json': {} },
      },
      parameters: [
        {
          in: 'header',
          name: 'Last-Event-ID',
          schema: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
          description: 'Decimal ordinal at most 9223372036854775807',
        },
      ],
      responses: {
        200: {
          description:
            'Official AG-UI SSE, beginning with RUN_STARTED on every reconnect; event IDs are durable public cursors',
          // The official fetch transport yields JSON-decoded values or raw text.
          // Consumers validate unknown frames with the official AG-UI schema.
          content: { 'text/event-stream': { schema: {} } },
        },
      },
    }),
    async (c) => {
      const rejection = requireJSON(c.req.raw)
      if (rejection) return rejection
      const query = ownedRun(c)
      if (!query) return invalid()
      return await openObservation(
        c.env.db,
        query,
        {
          body: await readBody(c.req.raw, c.env.bodyCollection),
          headers: c.req.raw.headers,
          signal: c.req.raw.signal,
        },
        {
          signal: c.env.signal,
          pollIntervalMs: c.env.pollIntervalMs,
          ...(c.env.ownRead ? { ownRead: c.env.ownRead } : {}),
          authorize: async () =>
            (await readIdentity(c.env.authentication, c.req.raw.headers))
              ?.id === query.ownerID &&
            (await readOwnedThread(c.env.db, query)) !== undefined,
        },
      )
    },
  )
  app.get(
    '/api/threads/:threadID/assets',
    describeRoute({
      operationId: 'listAssets',
      responses: {
        200: {
          description: 'Completed owned assets',
          content: json('AssetsResponse'),
        },
      },
    }),
    async (c) => {
      const query = ownedThread(c)
      return query
        ? Response.json({
            assets: await listAssets(c.env.db, query),
          } satisfies AssetsResponse)
        : invalid()
    },
  )
  app.post(
    '/api/threads/:threadID/assets',
    describeRoute({
      operationId: 'uploadAsset',
      description:
        'Raw bounded file bytes with an explicit allowlisted Content-Type header. Retry unknown receipts with the identical ID and bytes. Accepted file names exclude control characters; media bytes are verified.',
      parameters: [
        {
          in: 'header',
          name: 'x-asset-id',
          required: true,
          schema: { $ref: '#/components/schemas/UUIDInput' },
        },
        {
          in: 'header',
          name: 'x-file-name',
          required: true,
          schema: { type: 'string' },
          description: 'Percent-encoded UTF-8 file name',
        },
        {
          in: 'header',
          name: 'Content-Type',
          required: true,
          schema: { type: 'string', enum: uploadMimeTypeSchema.options },
          description:
            'Exact supported MIME type; bytes are verified independently',
        },
      ],
      requestBody: {
        required: true,
        content: fileContent,
      },
      responses: {
        201: { description: 'Uploaded', content: json('AssetResponse') },
        200: { description: 'Exact replay', content: json('AssetResponse') },
        408: { description: 'Upload body timed out; retry same ID and bytes' },
        413: { description: 'Upload exceeds byte limit' },
        415: { description: 'Invalid file' },
        503: { description: 'Upload unconfirmed; retry same ID and bytes' },
      },
    }),
    async (c) => {
      const query = ownedThread(c)
      if (!query || !c.env.files) return unavailable()
      await c.env.db
        .transaction()
        .execute((tx) => lockThread(tx, query, 'write'))
      return await uploadAsset(c.env.db, query, c.req.raw, c.env.files)
    },
  )
  app.get(
    '/api/assets/:assetID/file',
    describeRoute({
      operationId: 'downloadAsset',
      description:
        'Raw file bytes. Generated fetch callers must set parseAs="blob"; automatic MIME parsing can otherwise decode text or JSON attachments.',
      parameters: [
        {
          in: 'path',
          name: 'assetID',
          required: true,
          schema: { $ref: '#/components/schemas/UUIDInput' },
        },
      ],
      responses: {
        200: {
          description:
            'Binary attachment of any stored MIME type, including generated files outside the upload allowlist; private, no-store; nosniff; sandbox CSP',
          content: {
            '*/*': { schema: { type: 'string', format: 'binary' } },
          },
        },
        413: { description: 'File exceeds download limit' },
        503: { description: 'File unavailable or verification failed' },
      },
    }),
    async (c) => {
      const assetID = uuid.safeParse(c.req.param('assetID'))
      if (!assetID.success) return invalid()
      if (!c.env.files) return unavailable()
      return await downloadAsset(
        c.env.db,
        { ownerID: c.get('ownerID'), assetID: assetID.data },
        c.req.raw,
        c.env.files,
      )
    },
  )
  return app
}

function ownedThread(c: Context<HTTPEnv>) {
  const threadID = uuid.safeParse(c.req.param('threadID'))
  return threadID.success
    ? { ownerID: c.get('ownerID'), threadID: threadID.data }
    : null
}
function ownedRun(c: Context<HTTPEnv>) {
  const thread = ownedThread(c)
  const runID = uuid.safeParse(c.req.param('runID'))
  return thread && runID.success ? { ...thread, runID: runID.data } : null
}
function requireJSON(request: Request) {
  return request.headers.get('content-type')?.split(';')[0]?.trim() ===
    'application/json'
    ? null
    : new Response('Expected JSON request', { status: 415 })
}
export function createHTTP(db: Kysely<DB>, options: Omit<HTTPResources, 'db'>) {
  const app = createRouter()
  const resources = { ...options, db }
  return async (request: Request) => await app.fetch(request, resources)
}
