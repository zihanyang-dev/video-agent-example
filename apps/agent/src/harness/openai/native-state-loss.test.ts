import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model } from '@openai/agents'
import { createOpenAIHarness } from './adapter'
import { FileSession } from './session'

async function fixture(body: (path: string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), 'openai-state-loss-'))
  try {
    await body(path)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
}

test('initialized native history loss blocks run and completed without recreating history', () =>
  fixture(async (statePath) => {
    let models = 0
    let checkpoints = 0
    let reservations = 0
    let tools = 0
    const model: Model = {
      async getResponse() {
        throw new Error('Unexpected nonstream call')
      },
      async *getStreamedResponse() {
        models++
        yield {
          type: 'response_done',
          response: {
            id: 'fixture-response',
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
      modelID: 'fixture',
      baseURL: 'http://127.0.0.1:1',
      key: 'fixture',
      contextWindow: 10000,
      maxOutputTokens: 100,
      reasoning: 'low',
      input: ['text'],
      systemPrompt: 'fixture',
    })
    const input = {
      engine: 'openai' as const,
      threadID: crypto.randomUUID(),
      nativeSessionID: crypto.randomUUID(),
      runID: crypto.randomUUID(),
      text: 'first',
      requireExisting: false,
      signal: new AbortController().signal,
      beforeModel: async () => {
        reservations++
      },
      checkpoint: async () => {
        checkpoints++
      },
      onText: () => {},
      tools: {
        execute: async () => {
          tools++
          return { stdout: '', stderr: '', exitCode: 0 }
        },
        read: async () => {
          tools++
          return ''
        },
        write: async () => {
          tools++
        },
      },
    }
    expect((await harness.run(input)).text).toBe('done')
    expect(models).toBe(1)
    expect(checkpoints).toBeGreaterThan(0)
    const history = join(statePath, 'openai', input.threadID, 'session.json')
    const saved = JSON.parse(await readFile(history, 'utf8')) as { sessionID: string }
    expect(saved.sessionID).toBe(input.nativeSessionID)
    const before = { models, checkpoints, reservations, tools }
    await rm(history)
    await Promise.resolve(
      expect(harness.completed!({ ...input, requireExisting: true })).rejects.toThrow(
        'Native state lost',
      ),
    )
    await Promise.resolve(
      expect(harness.run({ ...input, requireExisting: true })).rejects.toThrow('Native state lost'),
    )
    await Promise.resolve(
      expect(
        harness.run({ ...input, runID: crypto.randomUUID(), requireExisting: true }),
      ).rejects.toThrow('Native state lost'),
    )
    expect({ models, checkpoints, reservations, tools }).toEqual(before)
    await Promise.resolve(expect(stat(history)).rejects.toThrow())
  }))

test('existing-only FileSession refuses a removed file on every read and mutation', () =>
  fixture(async (path) => {
    const history = join(path, 'session.json')
    await new FileSession(history, 'native').addItems([])
    // Once an existing durable file is observed, even first-creation admission
    // must not recreate it if it disappears later in the same SDK invocation.
    const session = new FileSession(history, 'native')
    expect(await session.getItems()).toEqual([])
    await rm(history)
    await Promise.resolve(expect(session.getItems()).rejects.toThrow('Native state lost'))
    await Promise.resolve(expect(session.addItems([])).rejects.toThrow('Native state lost'))
    await Promise.resolve(expect(stat(history)).rejects.toThrow())
  }))

test('completed lookup for an uninitialized identity never creates native files', () =>
  fixture(async (statePath) => {
    const harness = createOpenAIHarness({
      statePath,
      modelID: 'fixture',
      baseURL: 'http://127.0.0.1:1',
      key: 'fixture',
      contextWindow: 10000,
      maxOutputTokens: 100,
      reasoning: 'low',
      input: ['text'],
      systemPrompt: 'fixture',
    })
    expect(
      await harness.completed!({
        engine: 'openai',
        threadID: 'thread',
        nativeSessionID: 'native',
        runID: 'run',
        requireExisting: false,
      }),
    ).toBeUndefined()
    await Promise.resolve(expect(stat(join(statePath, 'openai'))).rejects.toThrow())
  }))
