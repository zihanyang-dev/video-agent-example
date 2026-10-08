import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model } from '@openai/agents'
import { createOpenAIHarness } from './adapter'
import { FileSession, writeJSON } from './session'

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

test('atomically bootstraps once, retains digest through compaction and isolates session storage', async () => {
  const statePath = await mkdtemp(join(tmpdir(), 'openai-bootstrap-'))
  const model: Model = {
    async getResponse() {
      throw new Error('Unexpected model call')
    },
    async *getStreamedResponse() {
      yield {
        type: 'response_done',
        response: {
          id: 'fixture',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'done' }],
            },
          ],
        },
      }
    },
  }
  const harness = createOpenAIHarness({
    statePath,
    model,
    baseURL: 'http://127.0.0.1:1',
    key: 'fixture',
    modelID: 'fixture',
    contextWindow: 16384,
    maxOutputTokens: 100,
    reasoning: 'low',
    input: ['text'],
    systemPrompt: 'fixture',
  })
  const input = {
    engine: 'openai' as const,
    threadID: 'thread',
    nativeSessionID: 'native',
    runID: 'run',
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
    beforeModel: async () => {},
  }
  try {
    const legacyPath = join(statePath, 'openai/thread/session.json')
    await writeJSON(legacyPath, {
      sessionID: 'native',
      items: [{ type: 'message', role: 'user', content: 'Legacy fixture input' }],
    })
    const legacyBytes = await readFile(legacyPath, 'utf8')
    expect((await harness.run(input)).text).toBe('done')
    expect(await readFile(legacyPath, 'utf8')).toBe(legacyBytes)
    const path = join(statePath, 'openai/thread/native/session.json')
    expect(existsSync(path)).toBe(true)
    const saved = JSON.parse(await readFile(path, 'utf8')) as {
      bootstrapDigest: string
      items: unknown[]
      admittedRuns: string[]
    }
    expect(saved.bootstrapDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(saved.items[1])).toContain('Historical answer')
    expect(saved.admittedRuns).toEqual(['run'])
    const file = new FileSession(path, 'native', true)
    await file.replaceHistoryWithCompaction([
      { type: 'message', role: 'user', content: 'compacted' },
    ])
    expect(
      (JSON.parse(await readFile(path, 'utf8')) as { bootstrapDigest: string }).bootstrapDigest,
    ).toBe(saved.bootstrapDigest)
    expect(
      (
        await harness.run({
          ...input,
          initialContext: { ...context, turns: [], throughRunID: null },
        })
      ).text,
    ).toBe('done')
    await Promise.resolve(
      expect(
        harness.run({
          ...input,
          runID: 'next',
          initialContext: { ...context, turns: [], throughRunID: null },
        }),
      ).rejects.toThrow('context'),
    )
    expect((await harness.run({ ...input, runID: 'next' })).text).toBe('done')
  } finally {
    await rm(statePath, { recursive: true, force: true })
  }
})

for (const store of [
  { sessionID: 'native', items: [] },
  { sessionID: 'native', items: [{ type: 'message', role: 'user', content: 'Existing input' }] },
  { sessionID: 'native', items: [], bootstrapDigest: 'malformed' },
])
  test('existing or malformed native state cannot be initialized with public context', async () => {
    const statePath = await mkdtemp(join(tmpdir(), 'openai-bootstrap-closed-'))
    try {
      const path = join(statePath, 'session.json')
      await writeJSON(path, store)
      const before = await readFile(path, 'utf8')
      await Promise.resolve(
        expect(new FileSession(path, 'native').bootstrap(context)).rejects.toThrow(),
      )
      expect(await readFile(path, 'utf8')).toBe(before)
    } finally {
      await rm(statePath, { recursive: true, force: true })
    }
  })

test('initialized missing native file rejects bootstrap without creating it', async () => {
  const statePath = await mkdtemp(join(tmpdir(), 'openai-bootstrap-missing-'))
  try {
    const path = join(statePath, 'missing.json')
    await Promise.resolve(
      expect(new FileSession(path, 'native', true).bootstrap(context)).rejects.toThrow(
        'Native state lost',
      ),
    )
    expect(existsSync(path)).toBe(false)
  } finally {
    await rm(statePath, { recursive: true, force: true })
  }
})

test('completed business history uses public user and assistant roles without internal identities', async () => {
  const statePath = await mkdtemp(join(tmpdir(), 'openai-context-roles-'))
  try {
    const session = new FileSession(join(statePath, 'session.json'), 'native')
    const asset = {
      assetID: '44444444-4444-4444-8444-444444444444',
      objectKey: 'PRIVATE_OBJECT_KEY',
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      byteLength: 12,
      sha256: 'a'.repeat(64),
    }
    await session.bootstrap({
      ...context,
      turns: [{ ...context.turns[0]!, input: { ...context.turns[0]!.input, assets: [asset] } }],
    })
    const items = await session.getItems()
    const text = JSON.stringify(items)
    expect(items).toHaveLength(2)
    expect(JSON.stringify(items[0])).toContain('Historical question')
    expect(JSON.stringify(items[1])).toContain('Historical answer')
    expect(items[0]).toMatchObject({ role: 'user' })
    expect(items[1]).toMatchObject({
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text' }],
    })
    for (const item of items) expect(item).not.toHaveProperty('id')
    expect(text).toContain('clip.mp4')
    expect(text).toContain('video/mp4')
    for (const id of [
      asset.assetID,
      asset.objectKey,
      asset.sha256,
      'byteLength',
      context.throughRunID,
      context.turns[0]!.input.messageID,
      context.turns[0]!.output.messageID,
    ])
      expect(text).not.toContain(id)
  } finally {
    await rm(statePath, { recursive: true, force: true })
  }
})
