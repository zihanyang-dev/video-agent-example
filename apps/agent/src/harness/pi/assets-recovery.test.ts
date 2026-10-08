import { expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { sha256, type ObjectStore } from '@vid/object-storage'
import type { AssetReference } from '@vid/contract/execution'
import type { SandboxTools } from '../../contract'
import { assignFileTools } from '../files'
import { createPiHarness } from './adapter'
import { retainPiAssets } from './session'

const settings = {
  key: 'owned-assets-key',
  modelID: 'owned-model',
  contextWindow: 16384,
  maxOutputTokens: 512,
  reasoning: false,
  input: ['text'] as ('text' | 'image')[],
  systemPrompt: 'Use only assigned remote tools.',
}

function stream(delta: unknown, finishReason: string) {
  return new Response(
    [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: finishReason },
    ]
      .map(
        (choice) =>
          `data: ${JSON.stringify({ id: 'owned', object: 'chat.completion.chunk', model: settings.modelID, choices: [{ index: 0, ...choice }] })}\n\n`,
      )
      .join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

for (const continuation of ['same-run', 'same-run-new-export', 'other-run'] as const) {
  test(`recovers trusted exported assets after a durable tool checkpoint: ${continuation}`, async () => {
    const statePath = await mkdtemp(join(tmpdir(), 'owned-pi-assets-'))
    const threadID = crypto.randomUUID()
    const nativeSessionID = crypto.randomUUID()
    const runID = crypto.randomUUID()
    const bytes = new Uint8Array([0, 255, 128, 13, 10])
    const requests: { messages: unknown[] }[] = []
    const uploads: AssetReference[] = []
    let guestReads = 0
    let unsafeEffect = false
    let durableExport: ReturnType<SessionManager['getBranch']> = []
    const objects: ObjectStore = {
      async read() {
        throw new Error('Unexpected object read')
      },
      async put(objectKey, content, mimeType) {
        expect(unsafeEffect).toBe(true)
        const digest = { byteLength: content.byteLength, sha256: sha256(content) }
        uploads.push({
          assetID: objectKey.split('/').at(-1)!,
          objectKey,
          name: uploads.length === 0 ? 'original.bin' : 'new.bin',
          mimeType,
          ...digest,
        })
        return digest
      },
      close() {},
    }
    const files = (assignedRunID: string) =>
      assignFileTools(objects, { maxBytes: 100, maxFiles: 4, timeoutMs: 1000 })(
        { threadID, runID: assignedRunID, fence: 3 },
        {
          async readBytes() {
            guestReads++
            return bytes
          },
          async writeBytes() {
            throw new Error('Unexpected guest write')
          },
        },
        () => {
          throw new Error('Unexpected unknown PUT outcome')
        },
        async () => {
          unsafeEffect = true
        },
      )
    const tools: SandboxTools = {
      async execute() {
        throw new Error('Unexpected command')
      },
      async read() {
        throw new Error('Unexpected read')
      },
      async write() {
        throw new Error('Unexpected write')
      },
    }
    const exportCall = (id: string, name: string) =>
      stream(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id,
              type: 'function',
              function: {
                name: 'export_file',
                arguments: JSON.stringify({
                  path: `/workspace/${name}`,
                  name,
                  mimeType: 'application/octet-stream',
                }),
              },
            },
          ],
        },
        'tool_calls',
      )
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        expect(request.headers.get('authorization')).toBe('Bearer owned-assets-key')
        requests.push((await request.json()) as { messages: unknown[] })
        if (requests.length === 1) return exportCall('original-export', 'original.bin')
        if (requests.length === 2) {
          expect(unsafeEffect).toBe(false)
          return new Response('Controlled interruption after checkpoint ACK', { status: 401 })
        }
        if (requests.length === 3 && continuation === 'same-run-new-export')
          return exportCall('new-export', 'new.bin')
        return stream({ role: 'assistant', content: 'Delivered from saved context.' }, 'stop')
      },
    })
    const options = { ...settings, statePath, baseURL: `http://127.0.0.1:${provider.port}/v1` }
    const input = {
      engine: 'pi' as const,
      threadID,
      nativeSessionID,
      runID,
      text: 'Export the original file and finish.',
      tools,
      signal: new AbortController().signal,
      onText() {},
      async beforeModel() {
        expect(unsafeEffect).toBe(false)
      },
      async checkpoint() {
        if (!unsafeEffect) return
        const directory = join(statePath, 'pi', threadID)
        const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl'))
        expect(names).toHaveLength(1)
        durableExport = SessionManager.open(join(directory, names[0]!)).getBranch()
        const latest = uploads.at(-1)!
        expect(
          durableExport.some(
            (entry) =>
              entry.type === 'custom' &&
              entry.customType === 'platform-asset' &&
              JSON.stringify(entry.data).includes(latest.objectKey),
          ),
        ).toBe(true)
        expect(
          durableExport.some(
            (entry) =>
              entry.type === 'message' &&
              entry.message.role === 'toolResult' &&
              JSON.stringify(entry.message.content).includes(latest.assetID),
          ),
        ).toBe(true)
        // This models the durable SQL effect ACK, not tool-entry admission.
        unsafeEffect = false
      },
    }
    try {
      const originalFiles = files(runID)
      expect(
        await createPiHarness(options)
          .run({ ...input, fileTools: originalFiles })
          .catch((error: unknown) => error),
      ).toBeInstanceOf(Error)
      expect(originalFiles.prepared).toEqual([uploads[0]!])
      expect(
        durableExport.some(
          (entry) =>
            entry.type === 'message' &&
            entry.message.role === 'toolResult' &&
            entry.message.toolCallId === 'original-export',
        ),
      ).toBe(true)
      const resumedRunID = continuation === 'other-run' ? crypto.randomUUID() : runID
      const freshFiles = files(resumedRunID)
      expect(freshFiles.prepared).toEqual([])
      let resumedCheckpoints = 0
      const resumed = createPiHarness(options)
      const attempt = await resumed
        .run({
          ...input,
          runID: resumedRunID,
          fileTools: freshFiles,
          async checkpoint() {
            await input.checkpoint()
            if (++resumedCheckpoints === 2 && continuation === 'same-run')
              throw new Error('Controlled final checkpoint acknowledgement loss')
          },
        })
        .catch((error: unknown) => error)
      if (continuation === 'same-run') expect(attempt).toBeInstanceOf(Error)
      const result = await resumed.completed!({
        engine: 'pi',
        threadID,
        nativeSessionID,
        runID: resumedRunID,
      })
      expect(result).toBeDefined()
      if (result === undefined) throw new Error('Missing durable final receipt')
      expect(result.text).toBe('Delivered from saved context.')
      expect(result.assets).toEqual(continuation === 'other-run' ? [] : uploads)
      expect(guestReads).toBe(continuation === 'same-run-new-export' ? 2 : 1)
      expect(uploads).toHaveLength(guestReads)
      expect(JSON.stringify(requests[2]!.messages)).toContain('original-export')
      expect(JSON.stringify(requests[2]!.messages)).toContain(uploads[0]!.assetID)
      expect(JSON.stringify(requests[2]!.messages)).not.toContain(uploads[0]!.objectKey)
      expect(
        durableExport.some(
          (entry) =>
            entry.type === 'custom' &&
            entry.customType === 'platform-asset' &&
            JSON.stringify(entry.data).includes(uploads[0]!.objectKey),
        ),
      ).toBe(true)
      const noIO = async (): Promise<never> => {
        throw new Error('Cached final must not perform IO')
      }
      const cached = createPiHarness({ ...options, baseURL: 'http://127.0.0.1:1/v1' })
      expect(
        await cached.completed!({ engine: 'pi', threadID, nativeSessionID, runID: resumedRunID }),
      ).toEqual(result)
      expect(
        await cached.run({ ...input, runID: resumedRunID, checkpoint: noIO, beforeModel: noIO }),
      ).toEqual(result)
    } finally {
      await provider.stop(true)
      await rm(statePath, { recursive: true, force: true })
    }
  }, 15000)
}

test('completed lookup never creates native state for a missing assigned session', async () => {
  const statePath = await mkdtemp(join(tmpdir(), 'owned-pi-assets-lookup-'))
  try {
    const harness = createPiHarness({ ...settings, statePath, baseURL: 'http://127.0.0.1:1/v1' })
    const identity = {
      engine: 'pi' as const,
      threadID: crypto.randomUUID(),
      nativeSessionID: crypto.randomUUID(),
      runID: crypto.randomUUID(),
    }
    expect(await harness.completed!(identity)).toBeUndefined()
    expect(await readdir(statePath)).toEqual([])
    expect(
      await harness.completed!({ ...identity, nativeSessionID: '../invalid' }).catch(
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(Error)
    expect(
      await harness.completed!({ ...identity, engine: 'openai' }).catch((error: unknown) => error),
    ).toBeInstanceOf(Error)
    expect(await readdir(statePath)).toEqual([])
  } finally {
    await rm(statePath, { recursive: true, force: true })
  }
})

test('native asset receipts deduplicate by stable ID and exclude other runs and nonreceipt data', () => {
  const manager = SessionManager.inMemory('/')
  const runID = crypto.randomUUID()
  const asset: AssetReference = {
    assetID: crypto.randomUUID(),
    objectKey: 'trusted-original-key',
    name: 'original.bin',
    mimeType: 'application/octet-stream',
    byteLength: 5,
    sha256: '6171db06a1c89b1ff8ab77e479d5df976ccd88a7b63567b4b18f413649e12ff3',
  }
  manager.appendCustomEntry('model-tool-result', {
    runID,
    asset: { ...asset, objectKey: 'untrusted-model-key' },
  })
  retainPiAssets(manager, crypto.randomUUID(), [
    { ...asset, assetID: crypto.randomUUID(), objectKey: 'other-run-key' },
  ])
  expect(retainPiAssets(manager, runID)).toEqual([])
  expect(retainPiAssets(manager, runID, [asset, asset])).toEqual([asset])
  expect(retainPiAssets(manager, runID, [{ ...asset, objectKey: 'duplicate-key' }])).toEqual([
    asset,
  ])
  expect(retainPiAssets(manager, runID)).toEqual([asset])
  expect(
    manager
      .getBranch()
      .filter((entry) => entry.type === 'custom' && entry.customType === 'platform-asset'),
  ).toHaveLength(2)
})
