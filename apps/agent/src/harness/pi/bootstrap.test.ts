import { expect, test } from 'bun:test'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { createPiHarness } from './adapter'
import {
  bootstrapPiSession,
  checkpointPiSession,
  openPiSession,
  readCompletedPiRequest,
} from './session'

const context = {
  version: 1 as const,
  throughRunID: '11111111-1111-4111-8111-111111111111',
  turns: [
    {
      runID: '11111111-1111-4111-8111-111111111111',
      input: { messageID: '22222222-2222-4222-8222-222222222222', text: 'Historical question' },
      output: { messageID: '33333333-3333-4333-8333-333333333333', text: 'Historical answer' },
    },
  ],
}

test('bootstraps completed reference before first input and checkpoints before dispatch', async () => {
  const statePath = await mkdtemp(join(tmpdir(), 'pi-bootstrap-'))
  const threadID = crypto.randomUUID()
  const nativeSessionID = crypto.randomUUID()
  const harness = createPiHarness({
    statePath,
    baseURL: 'http://127.0.0.1:1',
    key: 'fixture',
    modelID: 'fixture',
    contextWindow: 16384,
    maxOutputTokens: 100,
    reasoning: false,
    input: ['text'],
    systemPrompt: 'fixture',
  })
  const input = {
    engine: 'pi' as const,
    threadID,
    nativeSessionID,
    runID: crypto.randomUUID(),
    nativeSessionStorage: 'session' as const,
    initialContext: context,
    text: 'Current input',
    signal: new AbortController().signal,
    tools: {
      read: async () => '',
      write: async () => {},
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    onText: () => {},
    checkpoint: async () => {},
    beforeModel: async () => {
      throw new Error('Controlled stop before HTTP')
    },
  }
  try {
    const legacy = await openPiSession(statePath, threadID, nativeSessionID)
    legacy.appendMessage({ role: 'user', content: 'Legacy fixture input', timestamp: Date.now() })
    const legacyPath = legacy.getSessionFile()!
    const legacyBytes = await readFile(legacyPath, 'utf8')
    await Promise.resolve(expect(harness.run(input)).rejects.toThrow('Pi model execution failed'))
    expect(await readFile(legacyPath, 'utf8')).toBe(legacyBytes)
    const directory = join(statePath, 'pi', threadID, nativeSessionID)
    const file = SessionManager.findById('/', nativeSessionID, directory)
    expect(file).toBeDefined()
    const manager = SessionManager.open(file!, directory)
    const branch = manager.getBranch()
    const bootstrap = branch.findIndex(
      (entry) => entry.type === 'custom_message' && entry.customType === 'platform-context',
    )
    const marker = branch.findIndex(
      (entry) => entry.type === 'custom' && entry.customType === 'platform-input',
    )
    expect(bootstrap).toBeGreaterThanOrEqual(0)
    expect(marker).toBeGreaterThan(bootstrap)
    expect(JSON.stringify(manager.buildSessionContext().messages)).toContain('Historical answer')
    expect(JSON.stringify(manager.buildSessionContext().messages)).toContain('Current input')
    await Promise.resolve(
      expect(harness.run({ ...input, requireExisting: true })).rejects.toThrow(
        'Pi model execution failed',
      ),
    )
    expect(
      SessionManager.open(file!, directory)
        .getBranch()
        .filter(
          (entry) => entry.type === 'custom_message' && entry.customType === 'platform-context',
        ),
    ).toHaveLength(1)
    await Promise.resolve(
      expect(
        harness.run({ ...input, initialContext: { ...context, turns: [], throughRunID: null } }),
      ).rejects.toThrow('context'),
    )
    const retained = SessionManager.open(file!, directory)
    retained.appendCustomEntry('platform-completed', {
      runID: input.runID,
      result: { text: 'durable final' },
    })
    await checkpointPiSession(retained)
    expect(
      (
        await harness.run({
          ...input,
          initialContext: { ...context, turns: [], throughRunID: null },
          beforeModel: async () => {
            throw new Error('Must not dispatch replay')
          },
        })
      ).text,
    ).toBe('durable final')
    expect((await harness.completed!(input))?.text).toBe('durable final')
  } finally {
    await rm(statePath, { recursive: true, force: true })
  }
})

test('existing header-only native session cannot be silently bootstrapped as fresh', async () => {
  const statePath = await mkdtemp(join(tmpdir(), 'pi-bootstrap-header-'))
  try {
    const manager = await openPiSession(statePath, crypto.randomUUID(), crypto.randomUUID())
    await writeFile(manager.getSessionFile()!, `${JSON.stringify(manager.getHeader())}\n`)
    const reopened = SessionManager.open(manager.getSessionFile()!)
    expect(() => bootstrapPiSession(reopened, context)).toThrow('Existing native history')
  } finally {
    await rm(statePath, { recursive: true, force: true })
  }
})

test('native bootstrap metadata corruption fails closed instead of accepting its digest', () => {
  const manager = SessionManager.inMemory()
  bootstrapPiSession(manager, context)
  const original = manager.getEntries()[0]
  if (original?.type !== 'custom_message') throw new Error('Missing context fixture')
  const corrupted = SessionManager.inMemory()
  corrupted.appendCustomMessageEntry(
    'platform-context',
    'Lost original material',
    false,
    original.details,
  )
  expect(() => bootstrapPiSession(corrupted, context)).toThrow('context')
})

test('malformed initialized JSONL is rejected before SDK tolerant loading or new admission', async () => {
  const statePath = await mkdtemp(join(tmpdir(), 'pi-bootstrap-malformed-'))
  const threadID = crypto.randomUUID()
  const nativeSessionID = crypto.randomUUID()
  try {
    const manager = await openPiSession(statePath, threadID, nativeSessionID)
    manager.appendMessage({ role: 'user', content: 'Fixture input', timestamp: Date.now() })
    const path = manager.getSessionFile()!
    await appendFile(path, '{broken\n')
    const before = await readFile(path, 'utf8')
    await Promise.resolve(
      expect(
        openPiSession(statePath, threadID, nativeSessionID, { requireExisting: true }),
      ).rejects.toThrow('Invalid native Pi session'),
    )
    expect(() =>
      readCompletedPiRequest(statePath, {
        engine: 'pi',
        threadID,
        nativeSessionID,
        runID: crypto.randomUUID(),
        requireExisting: true,
      }),
    ).toThrow('Invalid native Pi session')
    expect(await readFile(path, 'utf8')).toBe(before)
  } finally {
    await rm(statePath, { recursive: true, force: true })
  }
})

test('public custom history contains safe descriptions but no internal identities', () => {
  const manager = SessionManager.inMemory()
  const asset = {
    assetID: '44444444-4444-4444-8444-444444444444',
    objectKey: 'PRIVATE_OBJECT_KEY',
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    byteLength: 12,
    sha256: 'a'.repeat(64),
  }
  bootstrapPiSession(manager, {
    ...context,
    turns: [{ ...context.turns[0]!, input: { ...context.turns[0]!.input, assets: [asset] } }],
  })
  const text = JSON.stringify(manager.buildSessionContext().messages)
  expect(text).toContain('Completed conversation history')
  expect(text).toContain('Historical question')
  expect(text).toContain('Historical answer')
  expect(text).toContain('clip.mp4')
  expect(text).toContain('video/mp4')
  for (const privateValue of [
    context.throughRunID,
    context.turns[0]!.input.messageID,
    context.turns[0]!.output.messageID,
    asset.assetID,
    asset.objectKey,
    asset.sha256,
    'byteLength',
  ])
    expect(text).not.toContain(privateValue)
})
