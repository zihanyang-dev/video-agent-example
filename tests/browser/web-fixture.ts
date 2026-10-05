import { join } from 'node:path'
import { EventType } from '@ag-ui/core'
import {
  threadCreationSchema,
  messageSubmissionSchema,
  runCancellationSchema,
  failedRunSchema,
} from '@vid/contract/http'
import type {
  PublicThread,
  PublicMessage,
  ActiveRun,
  FailedRun,
  PublicAsset,
} from '@vid/contract/http'

// Controlled HTTP proof only: no production auth bypass, database, or model.
const output = '/tmp/frame-web-fixture'
await Bun.build({
  entrypoints: ['apps/web/src/index.html'],
  outdir: output,
  target: 'browser',
})
const threadID = '11111111-1111-4111-8111-111111111111'
const runID = '22222222-2222-4222-8222-222222222222'
const createdAt = '2026-10-04T00:00:00Z'
const threads = new Map<string, PublicThread>([
  [threadID, { threadID, title: 'Fixture Chat', createdAt, archivedAt: null }],
])
const assets = new Map<
  string,
  { asset: PublicAsset; bytes: Uint8Array; threadID: string }
>()
const messages: PublicMessage[] = []
const activeRuns: ActiveRun[] = []
const failedRuns: FailedRun[] = []
const attempts: {
  operation: string
  body: unknown
  cookie: boolean
  contentType: string | null
}[] = []
const seen = new Map<string, string>()
let userID: string | null = 'alice'
function record(operation: string, body: unknown, request: Request) {
  attempts.push({
    operation,
    body,
    cookie:
      request.headers.get('cookie')?.includes('fixture-session=controlled') ??
      false,
    contentType: request.headers.get('content-type'),
  })
}
async function receipt(
  intent: { operation: string; identity: string; body: unknown },
  request: Request,
  response: unknown,
) {
  record(intent.operation, intent.body, request)
  const frozen = JSON.stringify(intent.body)
  const previous = seen.get(intent.identity)
  if (previous && previous !== frozen)
    return Response.json({ error: 'conflict' }, { status: 409 })
  seen.set(intent.identity, frozen)
  if (!previous) await Bun.sleep(100)
  return Response.json(
    previous ? response : { error: 'Receipt lost after acceptance' },
    { status: previous ? 200 : 503 },
  )
}
function selectedThread(request: Request) {
  const selected = new URL(request.url).pathname.split('/')[3] ?? ''
  const thread = threads.get(selected)
  if (!thread) throw new Error('Fixture thread missing')
  return thread
}
async function createChat(request: Request) {
  const intent = threadCreationSchema.parse(await request.json())
  const thread = threads.get(intent.threadID) ?? {
    ...intent,
    createdAt,
    archivedAt: null,
  }
  threads.set(thread.threadID, thread)
  return await receipt(
    { operation: 'create', identity: intent.threadID, body: intent },
    request,
    { thread },
  )
}
async function submitMessage(request: Request) {
  const intent = messageSubmissionSchema.parse(await request.json())
  if (!messages.some((message) => message.messageID === intent.messageID)) {
    messages.push({
      messageID: intent.messageID,
      role: 'user',
      text: intent.text,
      createdAt,
      assets: intent.assetIDs.flatMap((id) => {
        const entry = assets.get(id)
        return entry ? [entry.asset] : []
      }),
    })
    activeRuns.push({ runID, messageID: intent.messageID, status: 'running' })
  }
  return await receipt(
    { operation: 'message', identity: intent.messageID, body: intent },
    request,
    { messageID: intent.messageID, commandID: intent.messageID, runID },
  )
}
async function uploadFile(request: Request) {
  const assetID = request.headers.get('x-asset-id') ?? ''
  const name = decodeURIComponent(request.headers.get('x-file-name') ?? '')
  const bytes = new Uint8Array(await request.arrayBuffer())
  const mimeType = request.headers.get('content-type') ?? ''
  const asset: PublicAsset = {
    assetID,
    name,
    mimeType,
    byteLength: bytes.length,
    source: 'upload',
    createdAt,
  }
  assets.set(assetID, {
    asset,
    bytes,
    threadID: selectedThread(request).threadID,
  })
  return await receipt(
    {
      operation: 'upload',
      identity: assetID,
      body: { assetID, name, mimeType, bytes: [...bytes] },
    },
    request,
    { asset },
  )
}
async function cancelRun(request: Request) {
  const intent = runCancellationSchema.parse(await request.json())
  const response = await receipt(
    { operation: 'cancel', identity: intent.commandID, body: intent },
    request,
    { ...intent, runID },
  )
  if (response.status === 200 && activeRuns[0])
    activeRuns[0].status = 'stopping'
  return response
}
async function observe(request: Request) {
  record('events', await request.json(), request)
  const messageId = '33333333-3333-4333-8333-333333333333'
  const events = [
    {
      type: EventType.RUN_STARTED,
      threadId: selectedThread(request).threadID,
      runId: runID,
    },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: 'assistant',
      metadata: { eventID: 'fact:start' },
    },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: 'Public draft',
      metadata: { eventID: 'fact:0' },
    },
    {
      type: EventType.TEXT_MESSAGE_END,
      messageId,
      metadata: { eventID: 'fact:end', cursor: '1' },
    },
  ]
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}
function downloadFile(request: Request) {
  if (
    !userID ||
    !request.headers.get('cookie')?.includes('fixture-session=controlled')
  )
    return Response.json({}, { status: 401 })
  const assetID = new URL(request.url).pathname.split('/')[3] ?? ''
  const stored = assets.get(assetID)
  if (!stored) return new Response(null, { status: 404 })
  return new Response(Uint8Array.from(stored.bytes).buffer, {
    headers: {
      'Content-Type': stored.asset.mimeType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(stored.asset.name)}`,
    },
  })
}

const server = Bun.serve({
  hostname: '0.0.0.0',
  port: 4180,
  routes: {
    '/fixture/state': () =>
      Response.json({
        attempts,
        messages,
        activeRuns,
        failedRuns,
        assets: [...assets.values()].map((entry) => ({
          ...entry,
          bytes: [...entry.bytes],
        })),
      }),
    // Controlled terminal snapshot, deliberately without an SSE failure frame.
    '/fixture/fail': {
      POST: (request) => {
        const reason = failedRunSchema.shape.reason.parse(
          new URL(request.url).searchParams.get('reason') ?? 'execution-error',
        )
        for (const run of activeRuns)
          failedRuns.push({
            runID: run.runID,
            messageID: run.messageID,
            reason,
          })
        activeRuns.length = 0
        return Response.json({ failedRuns })
      },
    },
    '/fixture/account': (request) => {
      userID = new URL(request.url).searchParams.get('user')
      return Response.json({})
    },
    '/api/session': () =>
      Response.json({
        user: userID
          ? {
              userID,
              name: userID,
              email: `${userID}@example.com`,
              image: null,
            }
          : null,
      }),
    '/api/logout': {
      POST: () => {
        userID = null
        return Response.json({})
      },
    },
    '/api/threads': {
      GET: () =>
        Response.json({
          threads: userID === 'alice' ? [...threads.values()] : [],
        }),
      POST: createChat,
    },
    '/api/threads/:threadID': {
      GET: (request) =>
        userID === 'alice'
          ? Response.json({ thread: selectedThread(request) })
          : Response.json({}, { status: 403 }),
      PATCH: async (request) => {
        const edit = threadCreationSchema
          .pick({ title: true })
          .parse(await request.json())
        const thread = selectedThread(request)
        thread.title = edit.title
        return Response.json({ thread })
      },
    },
    '/api/threads/:threadID/archive': {
      POST: (request) => {
        selectedThread(request).archivedAt = createdAt
        activeRuns.length = 0
        return Response.json({})
      },
    },
    '/api/threads/:threadID/messages': {
      GET: () => Response.json({ messages, activeRuns, failedRuns }),
      POST: submitMessage,
    },
    '/api/threads/:threadID/assets': {
      GET: (request) =>
        Response.json({
          assets: [...assets.values()]
            .filter(
              (entry) => entry.threadID === selectedThread(request).threadID,
            )
            .map((entry) => entry.asset),
        }),
      POST: uploadFile,
    },
    '/api/assets/:assetID/file': { GET: downloadFile },
    '/api/threads/:threadID/runs/:runID/cancel': { POST: cancelRun },
    '/api/threads/:threadID/runs/:runID/events': { POST: observe },
  },
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/'))
      return new Response(null, { status: 404 })
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const file = Bun.file(join(output, path))
    return new Response(
      (await file.exists()) ? file : Bun.file(join(output, 'index.html')),
      {
        headers: {
          'Set-Cookie':
            'fixture-session=controlled; HttpOnly; SameSite=Lax; Path=/',
        },
      },
    )
  },
})
process.on('SIGTERM', () => {
  void server.stop(true)
})
console.log('Controlled web fixture listening on 4180')
