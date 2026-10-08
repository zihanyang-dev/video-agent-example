import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionLease } from '../../apps/agent/src/contract.ts'
import { acceptExecutionCommand } from '../../apps/agent/src/execution/db/command-acceptance'
import { claimExecutionRun } from '../../apps/agent/src/execution/db/execution-leases'
import { bindExecutionWrites } from '../../apps/agent/src/execution/db/run-writes'
import { executeRun } from '../../apps/agent/src/execution/execute-run'
import { createPiHarness } from '../../apps/agent/src/harness/pi/adapter'
import { assignFileTools } from '../../apps/agent/src/harness/files'
import { executionCommandSchema, executionEventSchema } from '@vid/contract/execution'
import { afterAll, expect, test } from 'bun:test'
import { connectObjects, sha256 } from '@vid/object-storage'
import { createHTTP } from '../../apps/server/src/http'
import { signedTestIdentity, storageSettings } from '../integration/authentication-fixture'
import { openTestDatabase } from '../integration/database-fixture'
import { acceptExecutionEvent } from '../../apps/server/src/db/execution-events'
import { completeAsset } from '../../apps/server/src/db/assets'
import { assetResponseSchema, messagesResponseSchema } from '@vid/contract/http'

const endpoint = process.env.STORAGE_TEST_ENDPOINT
if (!endpoint) throw new Error('Dedicated storage test endpoint required')
const { db, close } = openTestDatabase()
const nativeStatePath = await mkdtemp(join(tmpdir(), 'owned-storage-native-'))
const objectConnection = {
  endpoint,
  region: storageSettings.OBJECT_STORAGE_REGION,
  bucket: storageSettings.OBJECT_STORAGE_BUCKET,
  accessKeyID: storageSettings.OBJECT_STORAGE_ACCESS_KEY_ID,
  secretAccessKey: storageSettings.OBJECT_STORAGE_SECRET_ACCESS_KEY,
}
const objects = connectObjects(objectConnection)
const workerObjects = connectObjects({
  ...objectConnection,
  accessKeyID: 'owned-storage-worker',
  secretAccessKey: 'owned-storage-worker-secret',
})
afterAll(async () => {
  // The dedicated storage runner owns the ephemeral bucket. Neither application
  // principal can delete final assets; cleanup must not grant that capability.
  objects.close()
  workerObjects.close()
  await close()
  await rm(nativeStatePath, { recursive: true, force: true })
})
async function fixture() {
  const login = await signedTestIdentity(db)
  const threadID = crypto.randomUUID()
  const shutdown = new AbortController()
  const route = createHTTP(db, {
    authentication: login.authentication,
    signal: shutdown.signal,
    bodyCollection: { signal: shutdown.signal, timeoutMs: 5000 },
    maxAssetBytes: 1024,
    pollIntervalMs: 10,
    files: {
      objects,
      maxAssetBytes: 1024,
      timeoutMs: 5000,
      signal: shutdown.signal,
    },
  })
  async function request(
    path: string,
    method = 'GET',
    body?: string | Uint8Array,
    headers = login.headers,
  ) {
    return await route(
      new Request(`http://127.0.0.1:8787${path}`, {
        method,
        headers,
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : Buffer.from(body) }),
      }),
    )
  }
  expect(
    (await request('/api/threads', 'POST', JSON.stringify({ threadID, title: 'Files' }))).status,
  ).toBe(201)
  return { login, threadID, request, route }
}

async function uploadedAsset() {
  const f = await fixture()
  const assetID = crypto.randomUUID(),
    bytes = new TextEncoder().encode('asset bytes')
  const headers = new Headers(f.login.headers)
  headers.set('content-type', 'text/plain')
  headers.set('x-asset-id', assetID)
  headers.set('x-file-name', 'note.txt')
  const path = `/api/threads/${f.threadID}/assets`
  const uploaded = await f.request(path, 'POST', bytes, headers)
  expect(uploaded.status).toBe(201)
  const dto = assetResponseSchema.parse(await uploaded.json())
  expect(dto.asset.byteLength).toBe(bytes.length)
  expect(JSON.stringify(dto)).not.toContain('objectKey')
  return { f, assetID, bytes }
}
async function uploadedMessage() {
  const { f, assetID, bytes } = await uploadedAsset()
  const messageID = crypto.randomUUID()
  const body = JSON.stringify({
    messageID,
    text: '',
    assetIDs: [assetID],
  })
  const sent = await f.request(`/api/threads/${f.threadID}/messages`, 'POST', body)
  expect(sent.status).toBe(202)
  const result = await sent.json()
  expect(
    await (await f.request(`/api/threads/${f.threadID}/messages`, 'POST', body)).json(),
  ).toEqual(result)
  expect(
    (
      await f.request(
        `/api/threads/${f.threadID}/messages`,
        'POST',
        JSON.stringify({
          messageID,
          text: 'changed',
          assetIDs: [assetID],
        }),
      )
    ).status,
  ).toBe(409)
  const command = await db
    .selectFrom('product.command_outbox')
    .select('command')
    .where('command_id', '=', result.commandID)
    .executeTakeFirstOrThrow()
  expect(JSON.stringify(command.command)).toContain(`assets/uploads/${f.threadID}/${assetID}`)

  return { f, assetID, bytes, messageID, result }
}
async function completedAsset(
  input: Awaited<ReturnType<typeof uploadedMessage>>,
  mimeType = 'text/plain',
) {
  const { f, bytes, messageID, result, assetID: uploadID } = input
  const assetID = crypto.randomUUID(),
    assistantID = crypto.randomUUID()
  const key = `assets/generated/${f.threadID}/${result.runID}/1/${assetID}`
  const digest = await workerObjects.put(key, bytes, mimeType, AbortSignal.timeout(5000))
  const event = {
    version: 1 as const,
    kind: 'run-completed' as const,
    eventID: crypto.randomUUID(),
    threadID: f.threadID,
    runID: result.runID,
    messageID: assistantID,
    text: 'Done',
    assets: [
      {
        assetID,
        objectKey: key,
        name: 'result.txt',
        mimeType,
        ...digest,
      },
    ],
  }
  expect(await acceptExecutionEvent(db, { event, ordinal: 2 })).toBe('accepted')
  expect(await acceptExecutionEvent(db, { event, ordinal: 2 })).toBe('accepted')
  expect(
    await acceptExecutionEvent(db, {
      event: {
        ...event,
        assets: [{ ...event.assets[0]!, sha256: '0'.repeat(64) }],
      },
      ordinal: 2,
    }),
  ).toBe('conflict')
  const snapshot = messagesResponseSchema.parse(
    await (await f.request(`/api/threads/${f.threadID}/messages`)).json(),
  )
  expect(snapshot.messages.find((m) => m.messageID === messageID)?.assets?.[0]?.assetID).toBe(
    uploadID,
  )
  expect(snapshot.messages.find((m) => m.messageID === assistantID)?.assets?.[0]?.assetID).toBe(
    assetID,
  )
  expect(JSON.stringify(snapshot)).not.toContain(key)

  return { assetID, digest }
}
test('real bytes: owned upload, exact retry, conflict, private allocations, atomic assets and authenticated download', async () => {
  const input = await uploadedMessage()
  const { f, assetID, bytes } = input
  const headers = new Headers(f.login.headers)
  headers.set('content-type', 'text/plain')
  headers.set('x-asset-id', assetID)
  headers.set('x-file-name', 'note.txt')
  const path = `/api/threads/${f.threadID}/assets`
  const replayed = await f.request(path, 'POST', bytes, headers)
  expect(replayed.status).toBe(200)
  const replay = await replayed.json()
  expect(JSON.stringify(replay)).not.toContain('objectKey')
  expect(assetResponseSchema.parse(replay).asset.assetID).toBe(assetID)
  const conflict = await f.request(path, 'POST', new TextEncoder().encode('different'), headers)
  expect(conflict.status).toBe(409)
  await conflict.text()
  const { assetID: generatedID, digest } = await completedAsset(input)
  const downloaded = await f.request(`/api/assets/${generatedID}/file`)
  expect(downloaded.status).toBe(200)
  expect(sha256(new Uint8Array(await downloaded.arrayBuffer()))).toBe(digest.sha256)
  expect(downloaded.headers.get('content-disposition')).toContain('attachment')
  const foreign = await signedTestIdentity(db)
  expect(
    (await f.request(`/api/assets/${assetID}/file`, 'GET', undefined, foreign.headers)).status,
  ).toBe(404)
  expect(
    (await f.request(`/api/assets/${generatedID}/file`, 'GET', undefined, foreign.headers)).status,
  ).toBe(404)
  expect((await f.request('/api/logout', 'POST', '{}')).status).toBe(200)
  expect((await f.request(`/api/assets/${assetID}/file`)).status).toBe(401)
})

test('limits, foreign writes, archive, and unknown PUT receipt retain immutable pending reservation', async () => {
  const f = await fixture(),
    assetID = crypto.randomUUID()
  const headers = new Headers(f.login.headers)
  headers.set('content-type', 'text/plain')
  headers.set('x-asset-id', assetID)
  headers.set('x-file-name', 'note.txt')
  const path = `/api/threads/${f.threadID}/assets`
  expect((await f.request(path, 'POST', new Uint8Array(1025), headers)).status).toBe(413)
  const foreign = await signedTestIdentity(db),
    foreignHeaders = new Headers(headers)
  foreignHeaders.set('cookie', foreign.headers.get('cookie')!)
  expect(
    (await f.request(path, 'POST', new TextEncoder().encode('test'), foreignHeaders)).status,
  ).toBe(404)
  // Simulate a real S3 commit whose acknowledgement was lost: reserve immutable
  // SQL facts, store bytes, then let the actual HTTP retry observe conditional PUT.
  const bytes = new TextEncoder().encode('lost receipt'),
    key = `assets/uploads/${f.threadID}/${assetID}`
  await db
    .insertInto('product.assets')
    .values({
      asset_id: assetID,
      source: 'upload',
      thread_id: f.threadID,
      name: 'note.txt',
      mime_type: 'text/plain',
      byte_length: bytes.length,
      sha256: sha256(bytes),
      object_key: key,
    })
    .execute()
  await objects.put(key, bytes, 'text/plain', AbortSignal.timeout(5000))
  expect((await f.request(path, 'POST', bytes, headers)).status).toBe(201)
  expect((await f.request(`/api/threads/${f.threadID}/archive`, 'POST', '{}')).status).toBe(200)
  expect((await f.request(path, 'POST', bytes, headers)).status).toBe(409)
})

// This is a real product/worker/SQL/S3/Pi path with a local model endpoint and
// explicitly trusted in-memory VM. It does not prove E2B VM execution.
test('uploaded asset traverses actual worker execution and official Pi tools to a verified downloadable asset', async () => {
  const input = await uploadedMessage()
  const stored = await db
    .selectFrom('product.command_outbox')
    .select('command')
    .where('command_id', '=', input.result.commandID)
    .executeTakeFirstOrThrow()
  expect(await acceptExecutionCommand(db, executionCommandSchema.parse(stored.command))).toBe(
    'accepted',
  )
  const lease = await claimExecutionRun(db, {
    ownerID: 'asset-e2e',
    leaseMs: 30000,
  })
  if (!lease) throw new Error('Assigned run was not claimable')
  expect(lease.runID).toBe(input.result.runID)
  const vm = memoryVM()
  const model = toolModel(input.assetID, new TextDecoder().decode(input.bytes))
  try {
    expect(
      await executeRun(
        lease,
        {
          writes: bindExecutionWrites(db),
          fileTools: assignFileTools(workerObjects, {
            maxFiles: 8,
            maxBytes: 1024,
            timeoutMs: 5000,
          }),
          harness: createPiHarness({
            statePath: nativeStatePath,
            baseURL: model.url,
            key: 'local-test',
            modelID: 'local',
            contextWindow: 8192,
            maxOutputTokens: 1024,
            reasoning: false,
            input: ['text'],
            systemPrompt: 'Use assigned files.',
          }),
          openSandbox: async () => vm,
        },
        { leaseMs: 30000, pollMs: 100, signal: new AbortController().signal },
      ),
    ).toBe('completed')
    expect(vm.closed()).toBe(true)
    await publishAndDownload(input, lease)
    expect(model.readResult()).toBe(new TextDecoder().decode(input.bytes))
  } finally {
    await model.server.stop(true)
  }
})

function memoryVM() {
  const files = new Map<string, Uint8Array>()
  let closed = false
  return {
    nativeRef: { provider: 'e2b', id: crypto.randomUUID() },
    closed: () => closed,
    close: async () => {
      closed = true
    },
    readBytes: async (path: string) => {
      const bytes = files.get(path)
      if (!bytes) throw new Error('Missing assigned file')
      return bytes
    },
    writeBytes: async (path: string, bytes: Uint8Array) => {
      files.set(path, bytes)
    },
    read: async ({ path }: { path: string }) => {
      const bytes = files.get(path)
      if (!bytes) throw new Error('Missing assigned file')
      return new TextDecoder().decode(bytes)
    },
    write: async ({ path, content }: { path: string; content: string }) => {
      files.set(path, new TextEncoder().encode(content))
    },
    execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  }
}
const chosenTools = (assetID: string, readResult: string) => [
  {
    name: 'import_file',
    arguments: JSON.stringify({ assetID, path: '/tmp/input.txt' }),
  },
  { name: 'read', arguments: JSON.stringify({ path: '/tmp/input.txt' }) },
  {
    name: 'write',
    arguments: JSON.stringify({
      path: '/tmp/result.txt',
      content: readResult,
    }),
  },
  {
    name: 'export_file',
    arguments: JSON.stringify({
      path: '/tmp/result.txt',
      name: 'result.txt',
      mimeType: 'text/plain',
    }),
  },
]
function toolModel(assetID: string, expected: string) {
  let requestCount = 0
  let readResult: string | undefined
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        messages: { role: string; tool_call_id?: string; content?: string }[]
      }
      const turn = ++requestCount
      if (turn === 2) {
        const imported = body.messages.filter(
          (message) => message.role === 'tool' && message.tool_call_id === 'local-tool-1',
        )
        expect(imported).toHaveLength(1)
        expect(imported[0]?.content).toBe(
          'Imported to /tmp/input.txt. Use tools to inspect; importing does not establish understanding.',
        )
      }
      if (turn === 3) {
        const read = body.messages.filter(
          (message) => message.role === 'tool' && message.tool_call_id === 'local-tool-2',
        )
        expect(read).toHaveLength(1)
        expect(read[0]?.content).toBe(expected)
        readResult = read[0]!.content!
      }
      const tools = chosenTools(assetID, readResult ?? '')
      const tool = tools[turn - 1]
      const delta =
        tool !== undefined
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `local-tool-${turn}`,
                  type: 'function',
                  function: tool,
                },
              ],
            }
          : { role: 'assistant', content: 'Done' }
      const chunk = {
        id: 'local',
        object: 'chat.completion.chunk',
        model: 'local',
        choices: [
          {
            index: 0,
            delta,
            finish_reason: tool === undefined ? 'stop' : 'tool_calls',
          },
        ],
      }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  return {
    server,
    readResult: () => readResult,
    url: `http://127.0.0.1:${server.port}/v1`,
  }
}

async function publishAndDownload(
  input: Awaited<ReturnType<typeof uploadedMessage>>,
  lease: ExecutionLease,
) {
  const rows = await db
    .selectFrom('execution.event_outbox')
    .selectAll()
    .where('run_id', '=', lease.runID)
    .orderBy('ordinal', 'desc')
    .execute()
  for (const row of rows)
    expect(
      await acceptExecutionEvent(db, {
        event: executionEventSchema.parse(row.event),
        ordinal: row.ordinal,
      }),
    ).toBe('accepted')
  const assets = await db
    .selectFrom('product.assets')
    .selectAll()
    .where('run_id', '=', lease.runID)
    .execute()
  expect(assets).toHaveLength(1)
  const asset = assets[0]!
  const response = await input.f.request(`/api/assets/${asset.asset_id}/file`)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('asset bytes')
}

test('message asset links are ordered immutable authority and foreign-thread IDs do not disclose existence', async () => {
  const { f, assetID, bytes } = await uploadedAsset()
  const secondID = crypto.randomUUID()
  const headers = new Headers(f.login.headers)
  headers.set('x-asset-id', secondID)
  headers.set('x-file-name', 'second.txt')
  headers.set('content-type', 'text/plain')
  expect(
    (await f.request(`/api/threads/${f.threadID}/assets`, 'POST', bytes, headers)).status,
  ).toBe(201)
  const messageID = crypto.randomUUID(),
    path = `/api/threads/${f.threadID}/messages`
  const body = JSON.stringify({
    messageID,
    text: '',
    assetIDs: [secondID, assetID],
  })
  const first = await f.request(path, 'POST', body)
  expect(first.status).toBe(202)
  expect(await (await f.request(path, 'POST', body)).json()).toEqual(await first.json())
  expect(
    (
      await f.request(
        path,
        'POST',
        JSON.stringify({
          messageID,
          text: '',
          assetIDs: [assetID, secondID],
        }),
      )
    ).status,
  ).toBe(409)
  await rejectForeignAsset(assetID)
  const snapshot = messagesResponseSchema.parse(await (await f.request(path)).json())
  expect(
    snapshot.messages
      .find((message) => message.messageID === messageID)
      ?.assets?.map((asset) => asset.assetID),
  ).toEqual([secondID, assetID])
})

test('asset namespace conflict rolls back receipt, assistant message, and asset in one transaction', async () => {
  const { f, result } = await uploadedMessage()
  const assetID = crypto.randomUUID(),
    messageID = crypto.randomUUID(),
    eventID = crypto.randomUUID()
  const event = {
    version: 1 as const,
    kind: 'run-completed' as const,
    eventID,
    threadID: f.threadID,
    runID: result.runID,
    messageID,
    text: 'bad',
    assets: [
      {
        assetID,
        name: 'bad.txt',
        mimeType: 'text/plain',
        byteLength: 1,
        sha256: '0'.repeat(64),
        objectKey: `assets/generated/${crypto.randomUUID()}/${result.runID}/1/${assetID}`,
      },
    ],
  }
  expect(await acceptExecutionEvent(db, { event, ordinal: 1 })).toBe('conflict')
  expect(
    await db
      .selectFrom('product.execution_events')
      .select('event_id')
      .where('event_id', '=', eventID)
      .execute(),
  ).toEqual([])
  expect(
    await db
      .selectFrom('product.messages')
      .select('message_id')
      .where('message_id', '=', messageID)
      .execute(),
  ).toEqual([])
  expect(
    await db
      .selectFrom('product.assets')
      .select('asset_id')
      .where('asset_id', '=', assetID)
      .execute(),
  ).toEqual([])
  expect(
    await acceptExecutionEvent(db, {
      event: { ...event, runID: crypto.randomUUID() },
      ordinal: 1,
    }),
  ).toBe('unknown-run')
})

async function rejectForeignAsset(assetID: string) {
  const other = await fixture()
  expect(
    (
      await other.request(
        `/api/threads/${other.threadID}/messages`,
        'POST',
        JSON.stringify({
          messageID: crypto.randomUUID(),
          text: '',
          assetIDs: [assetID],
        }),
      )
    ).status,
  ).toBe(404)
}

test('chunked binary collection stops at the byte budget without trusting a short Content-Length', async () => {
  const f = await fixture(),
    id = crypto.randomUUID()
  const headers = new Headers(f.login.headers)
  headers.set('content-type', 'text/plain')
  headers.set('x-asset-id', id)
  headers.set('x-file-name', 'chunks.txt')
  headers.set('content-length', '1')
  let pulled = 0,
    cancelled = false
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled += 1
        controller.enqueue(new Uint8Array(700).fill(65))
      },
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  const response = await f.route(
    new Request(`http://127.0.0.1:8787/api/threads/${f.threadID}/assets`, {
      method: 'POST',
      headers,
      body,
    }),
  )
  expect(response.status).toBe(413)
  expect(pulled).toBe(2)
  expect(cancelled).toBe(true)
  expect(
    await db.selectFrom('product.assets').select('asset_id').where('asset_id', '=', id).execute(),
  ).toEqual([])
})

test('binary image uploads preserve actual non-text bytes and reject spoofed MIME before object effects', async () => {
  const f = await fixture(),
    assetID = crypto.randomUUID()
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=',
    'base64',
  )
  const headers = new Headers(f.login.headers)
  headers.set('content-type', 'image/png')
  headers.set('x-asset-id', assetID)
  headers.set('x-file-name', 'pixel.png')
  const path = `/api/threads/${f.threadID}/assets`
  expect(
    (await f.request(path, 'POST', new TextEncoder().encode('fake image'), headers)).status,
  ).toBe(415)
  expect((await f.request(path, 'POST', bytes, headers)).status).toBe(201)
  const response = await f.request(`/api/assets/${assetID}/file`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('image/png')
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes))
})

test('simultaneous same-content upload retries have one creation response and one replay', async () => {
  const f = await fixture()
  const assetID = crypto.randomUUID()
  const headers = new Headers(f.login.headers)
  headers.set('content-type', 'text/plain')
  headers.set('x-asset-id', assetID)
  headers.set('x-file-name', encodeURIComponent('剪辑 "take".txt'))
  const upload = () =>
    f.request(
      `/api/threads/${f.threadID}/assets`,
      'POST',
      new TextEncoder().encode('same'),
      headers,
    )
  const responses = await Promise.all([upload(), upload()])
  expect(responses.map((response) => response.status).sort((left, right) => left - right)).toEqual([
    200, 201,
  ])
  const downloaded = await f.request(`/api/assets/${assetID}/file`)
  expect(downloaded.headers.get('content-disposition')).toContain("filename*=UTF-8''%E5")
  expect(downloaded.headers.get('x-content-type-options')).toBe('nosniff')
  expect(downloaded.headers.get('cache-control')).toBe('private, no-store')
})

test('a prior generated asset is selectable in an asset-only message with exact replay authority', async () => {
  const input = await uploadedMessage()
  const generated = await completedAsset(input)
  const messageID = crypto.randomUUID()
  const path = `/api/threads/${input.f.threadID}/messages`
  const body = JSON.stringify({
    messageID,
    text: '',
    assetIDs: [generated.assetID],
  })
  const accepted = await input.f.request(path, 'POST', body)
  expect(accepted.status).toBe(202)
  expect(await (await input.f.request(path, 'POST', body)).json()).toEqual(await accepted.json())
  expect(
    (
      await input.f.request(
        path,
        'POST',
        JSON.stringify({ messageID, text: '', assetIDs: [input.assetID] }),
      )
    ).status,
  ).toBe(409)
  const snapshot = messagesResponseSchema.parse(await (await input.f.request(path)).json())
  expect(
    snapshot.messages.find((message) => message.messageID === messageID)?.assets?.[0]?.source,
  ).toBe('generated')
  await rejectForeignAsset(generated.assetID)
})

test('expired sessions cannot read asset bytes, and untrusted upload origins have no object or SQL effects', async () => {
  const { f, assetID, bytes } = await uploadedAsset()
  const newID = crypto.randomUUID()
  const headers = new Headers(f.login.headers)
  headers.set('origin', 'https://attacker.example')
  headers.set('content-type', 'text/plain')
  headers.set('x-asset-id', newID)
  headers.set('x-file-name', 'note.txt')
  expect(
    (await f.request(`/api/threads/${f.threadID}/assets`, 'POST', bytes, headers)).status,
  ).toBe(403)
  expect(
    await db
      .selectFrom('product.assets')
      .select('asset_id')
      .where('asset_id', '=', newID)
      .execute(),
  ).toEqual([])
  await db
    .updateTable('auth.session')
    .set({ expiresAt: new Date(0) })
    .where('id', '=', f.login.session.id)
    .execute()
  expect((await f.request(`/api/assets/${assetID}/file`)).status).toBe(401)
})

test('generated empty text files retain their zero-byte digest and remain downloadable', async () => {
  const input = await uploadedMessage()
  const { assetID } = await completedAsset({
    ...input,
    bytes: new Uint8Array(),
  })
  const downloaded = await input.f.request(`/api/assets/${assetID}/file`)
  expect(downloaded.status).toBe(200)
  expect((await downloaded.arrayBuffer()).byteLength).toBe(0)
})

test('accepted arbitrary binary exports remain authenticated downloadable attachments', async () => {
  const input = await uploadedMessage()
  const bytes = new Uint8Array([0, 255])
  const { assetID } = await completedAsset({ ...input, bytes }, 'application/octet-stream')
  const downloaded = await input.f.request(`/api/assets/${assetID}/file`)
  expect(downloaded.status).toBe(200)
  expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes)
  expect(downloaded.headers.get('content-type')).toBe('application/octet-stream')
  expect(downloaded.headers.get('content-disposition')).toContain('attachment;')
  expect(downloaded.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
})

test('native Fetch sends raw file headers and receives a verified attachment', async () => {
  const f = await fixture()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: f.route })
  const assetID = crypto.randomUUID()
  const body = new Blob(['native Fetch bytes'], { type: 'text/plain' })
  const headers = {
    'x-asset-id': assetID,
    'x-file-name': encodeURIComponent('剪辑.txt'),
    'Content-Type': 'text/plain' as const,
  }
  try {
    const uploadHeaders = new Headers(f.login.headers)
    for (const [name, value] of Object.entries(headers)) uploadHeaders.set(name, value)
    const uploaded = await fetch(new URL(`/api/threads/${f.threadID}/assets`, server.url), {
      method: 'POST',
      headers: uploadHeaders,
      body,
    })
    expect(uploaded.status).toBe(201)
    expect(assetResponseSchema.parse(await uploaded.json()).asset.assetID).toBe(assetID)
    const replay = await fetch(new URL(`/api/threads/${f.threadID}/assets`, server.url), {
      method: 'POST',
      headers: uploadHeaders,
      body,
    })
    expect(replay.status).toBe(200)
    const downloaded = await fetch(new URL(`/api/assets/${assetID}/file`, server.url), {
      headers: f.login.headers,
    })
    expect(downloaded.status).toBe(200)
    const bytes = new Uint8Array(await downloaded.arrayBuffer())
    expect(sha256(bytes)).toBe(sha256(new Uint8Array(await body.arrayBuffer())))
    expect(new TextDecoder().decode(bytes)).toBe('native Fetch bytes')
    expect(downloaded.headers.get('content-type')).toBe('text/plain')
    expect(downloaded.headers.get('content-disposition')).toContain('attachment;')
    expect(downloaded.headers.get('x-content-type-options')).toBe('nosniff')
    expect(downloaded.headers.get('cache-control')).toBe('private, no-store')
    expect(downloaded.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
  } finally {
    await server.stop(true)
  }
})

test('pending historical upload recovers on the writable prefix with stable identity and immutable retry location', async () => {
  const f = await fixture()
  const assetID = crypto.randomUUID()
  const bytes = new TextEncoder().encode('historical pending bytes')
  const legacyKey = `materials/${f.threadID}/${assetID}`
  const newKey = `assets/uploads/${f.threadID}/${assetID}`
  await db
    .insertInto('product.assets')
    .values({
      asset_id: assetID,
      thread_id: f.threadID,
      source: 'upload',
      name: 'pending.txt',
      mime_type: 'text/plain',
      byte_length: bytes.length,
      sha256: sha256(bytes),
      object_key: legacyKey,
    })
    .execute()
  expect(
    await objects.put(legacyKey, bytes, 'text/plain', AbortSignal.timeout(5000)).then(
      () => false,
      () => true,
    ),
  ).toBe(true)
  const headers = new Headers(f.login.headers)
  headers.set('content-type', 'text/plain')
  headers.set('x-asset-id', assetID)
  headers.set('x-file-name', 'pending.txt')
  const upload = () => f.request(`/api/threads/${f.threadID}/assets`, 'POST', bytes, headers)
  const responses = await Promise.all([upload(), upload()])
  expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 201])
  const row = await db
    .selectFrom('product.assets')
    .selectAll()
    .where('asset_id', '=', assetID)
    .executeTakeFirstOrThrow()
  expect(row.object_key).toBe(newKey)
  expect(row.ready_at).not.toBeNull()
  expect(row.sha256).toBe(sha256(bytes))
  const download = await f.request(`/api/assets/${assetID}/file`)
  expect(download.status).toBe(200)
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes)
  expect((await upload()).status).toBe(200)
  expect(
    (
      await db
        .selectFrom('product.assets')
        .select('object_key')
        .where('asset_id', '=', assetID)
        .executeTakeFirstOrThrow()
    ).object_key,
  ).toBe(newKey)
})

// Only an explicitly provisioned fixture administrator may seed historical
// objects. Application principals remain read-only on the legacy namespaces.
const legacyAdminKey = process.env.STORAGE_TEST_ADMIN_ACCESS_KEY
const legacyAdminSecret = process.env.STORAGE_TEST_ADMIN_SECRET_KEY
const legacyAdmin =
  legacyAdminKey && legacyAdminSecret
    ? connectObjects({
        ...objectConnection,
        accessKeyID: legacyAdminKey,
        secretAccessKey: legacyAdminSecret,
      })
    : null
afterAll(() => legacyAdmin?.close())

test.skipIf(!legacyAdmin)(
  'a committed historical PUT is confirmed in place and ready legacy replays never rehome',
  async () => {
    if (!legacyAdmin) throw new Error('Explicit fixture administrator required')
    const f = await fixture()
    const assetID = crypto.randomUUID()
    const bytes = new TextEncoder().encode('uncertain historical receipt')
    const key = `materials/${f.threadID}/${assetID}`
    await legacyAdmin.put(key, bytes, 'text/plain', AbortSignal.timeout(5000))
    await db
      .insertInto('product.assets')
      .values({
        asset_id: assetID,
        thread_id: f.threadID,
        source: 'upload',
        name: 'legacy.txt',
        mime_type: 'text/plain',
        byte_length: bytes.length,
        sha256: sha256(bytes),
        object_key: key,
      })
      .execute()
    const headers = new Headers(f.login.headers)
    headers.set('content-type', 'text/plain')
    headers.set('x-asset-id', assetID)
    headers.set('x-file-name', 'legacy.txt')
    const upload = () => f.request(`/api/threads/${f.threadID}/assets`, 'POST', bytes, headers)
    expect((await upload()).status).toBe(201)
    expect((await upload()).status).toBe(200)
    const row = await db
      .selectFrom('product.assets')
      .selectAll()
      .where('asset_id', '=', assetID)
      .executeTakeFirstOrThrow()
    expect(row.object_key).toBe(key)
    expect(row.ready_at).not.toBeNull()
    expect(await objects.read(key, 1024, AbortSignal.timeout(5000))).toEqual(bytes)
    expect(
      await objects
        .read(`assets/uploads/${f.threadID}/${assetID}`, 1024, AbortSignal.timeout(5000))
        .then(
          () => false,
          () => true,
        ),
    ).toBe(true)
    const download = await f.request(`/api/assets/${assetID}/file`)
    expect(download.status).toBe(200)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes)
  },
)

test.skipIf(!legacyAdmin)(
  'concurrent confirmed legacy and rehome publications keep the first ready location and both immutable objects',
  async () => {
    if (!legacyAdmin) throw new Error('Explicit fixture administrator required')
    const f = await fixture()
    const assetID = crypto.randomUUID()
    const bytes = new TextEncoder().encode('same historical bytes')
    const oldKey = `materials/${f.threadID}/${assetID}`
    const newKey = `assets/uploads/${f.threadID}/${assetID}`
    await legacyAdmin.put(oldKey, bytes, 'text/plain', AbortSignal.timeout(5000))
    await objects.put(newKey, bytes, 'text/plain', AbortSignal.timeout(5000))
    await db
      .insertInto('product.assets')
      .values({
        asset_id: assetID,
        thread_id: f.threadID,
        source: 'upload',
        name: 'race.txt',
        mime_type: 'text/plain',
        byte_length: bytes.length,
        sha256: sha256(bytes),
        object_key: oldKey,
      })
      .execute()
    const query = { ownerID: f.login.session.userId, threadID: f.threadID }
    const results = await Promise.all([
      completeAsset(db, query, { assetID, confirmedObjectKey: oldKey }),
      completeAsset(db, query, { assetID, confirmedObjectKey: newKey }),
    ])
    expect(results.map((result) => result.created).sort((a, b) => Number(a) - Number(b))).toEqual([
      false,
      true,
    ])
    const winner = results[0]!.created ? oldKey : newKey
    const row = await db
      .selectFrom('product.assets')
      .selectAll()
      .where('asset_id', '=', assetID)
      .executeTakeFirstOrThrow()
    expect(row.object_key).toBe(winner)
    await completeAsset(db, query, {
      assetID,
      confirmedObjectKey: winner === oldKey ? newKey : oldKey,
    })
    const replay = await db
      .selectFrom('product.assets')
      .selectAll()
      .where('asset_id', '=', assetID)
      .executeTakeFirstOrThrow()
    expect(replay.object_key).toBe(winner)
    expect(replay.ready_at).toEqual(row.ready_at)
    expect(await objects.read(oldKey, 1024, AbortSignal.timeout(5000))).toEqual(bytes)
    expect(await objects.read(newKey, 1024, AbortSignal.timeout(5000))).toEqual(bytes)
  },
)
