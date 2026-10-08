import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model, ModelRequest } from '@openai/agents'
import { createOpenAIHarness } from './adapter.ts'
import { writeJSON } from './session.ts'

// Same public controlled-model protocol as adapter.test.ts; the Runner saves real SDK state.
function controlledModel(): Model {
  return {
    async getResponse() {
      throw new Error('Unexpected nonstream call')
    },
    async *getStreamedResponse(request: ModelRequest) {
      const hasResult =
        Array.isArray(request.input) && request.input.some((i) => i.type === 'function_call_result')
      yield {
        type: 'response_done',
        response: {
          id: hasResult ? 'final' : 'tool',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          output: hasResult
            ? [
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'done' }],
                },
              ]
            : [
                {
                  type: 'function_call',
                  callId: 'read-1',
                  name: 'read',
                  arguments: '{"path":"/guest/file"}',
                  status: 'completed',
                },
              ],
        },
      }
    },
  }
}

const options = (statePath: string) => ({
  statePath,
  modelID: 'gpt-controlled',
  baseURL: 'http://127.0.0.1:1',
  key: 'controlled',
  contextWindow: 10000,
  maxOutputTokens: 100,
  reasoning: 'low' as const,
  input: ['text'],
  systemPrompt: 'test',
})
const request = {
  engine: 'openai' as const,
  threadID: 'thread',
  nativeSessionID: 'native',
  runID: 'run',
  text: 'original',
  signal: new AbortController().signal,
  beforeModel: async () => {},
  checkpoint: async () => {},
  onText: () => {},
  tools: {
    execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    read: async () => 'observed',
    write: async () => {},
  },
}

async function fixture(
  body: (context: {
    path: string
    snapshotPath: string
    historyPath: string
    snapshot: Record<string, unknown>
  }) => Promise<void>,
) {
  const path = await mkdtemp(join(tmpdir(), 'openai-snapshot-format-'))
  try {
    await createOpenAIHarness({ ...options(path), model: controlledModel() }).run(request)
    const snapshotPath = join(path, 'openai/thread/runs/run.json')
    const historyPath = join(path, 'openai/thread/session.json')
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as Record<string, unknown>
    await body({ path, snapshotPath, historyPath, snapshot })
  } finally {
    await rm(path, { recursive: true, force: true })
  }
}

function guarded(path: string) {
  const calls = { checkpoints: 0, providers: 0, models: 0, reservations: 0, http: 0, tools: 0 }
  const http = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async () => {
        calls.http++
        throw new Error('Unexpected HTTP dispatch')
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  const harness = createOpenAIHarness({
    ...options(path),
    modelProvider: {
      async getModel() {
        calls.providers++
        return {
          async getResponse() {
            calls.models++
            throw new Error('Unexpected model dispatch')
          },
          getStreamedResponse() {
            calls.models++
            throw new Error('Unexpected model dispatch')
          },
        }
      },
    },
  })
  const input = {
    ...request,
    checkpoint: async () => {
      calls.checkpoints++
    },
    beforeModel: async () => {
      calls.reservations++
    },
    tools: {
      execute: async () => {
        calls.tools++
        throw new Error('Unexpected tool dispatch')
      },
      read: async () => {
        calls.tools++
        throw new Error('Unexpected tool dispatch')
      },
      write: async () => {
        calls.tools++
        throw new Error('Unexpected tool dispatch')
      },
    },
  }
  return { harness, input, calls, restore: () => http.mockRestore() }
}

async function disk(path: string) {
  const info = await stat(path)
  return { bytes: await readFile(path, 'utf8'), inode: info.ino, modified: info.mtimeMs }
}

const invalid: [string, (snapshot: Record<string, unknown>) => unknown][] = [
  ['null root', () => null],
  ['array root', () => []],
  ['primitive root', () => false],
  [
    'missing identity',
    (s) => {
      const copy = { ...s }
      delete copy.nativeSessionID
      return copy
    },
  ],
  ['nonstring identity', (s) => ({ ...s, nativeSessionID: 42 })],
  [
    'missing state',
    (s) => {
      const copy = { ...s }
      delete copy.state
      return copy
    },
  ],
  ['null state', (s) => ({ ...s, state: null })],
  ['object state', (s) => ({ ...s, state: {} })],
  [
    'missing sources',
    (s) => {
      const copy = { ...s }
      delete copy.sources
      return copy
    },
  ],
  ['null sources', (s) => ({ ...s, sources: null })],
  ['invalid source', (s) => ({ ...s, sources: [{ title: 'Bad', url: 'http://localhost' }] })],
  [
    'missing assets',
    (s) => {
      const copy = { ...s }
      delete copy.assets
      return copy
    },
  ],
  ['object assets', (s) => ({ ...s, assets: {} })],
  ['invalid asset', (s) => ({ ...s, assets: [{ assetID: 'not-an-asset' }] })],
  ['null completion', (s) => ({ ...s, completion: null })],
  ['primitive completion', (s) => ({ ...s, completion: 'done' })],
  ['missing completion text', (s) => ({ ...s, completion: {} })],
  ['nonstring completion text', (s) => ({ ...s, completion: { text: 42 } })],
  ['invalid completion sources', (s) => ({ ...s, completion: { text: 'done', sources: [null] } })],
  ['invalid completion assets', (s) => ({ ...s, completion: { text: 'done', assets: [null] } })],
  ['unknown envelope field', (s) => ({ ...s, unexpected: true })],
  ['unknown completion field', (s) => ({ ...s, completion: { text: 'done', unexpected: true } })],
]

for (const [name, poison] of invalid) {
  test(`present snapshot with ${name} rejects both entrypoints before admission without disk changes`, () =>
    fixture(async ({ path, snapshotPath, historyPath, snapshot }) => {
      await writeJSON(snapshotPath, poison(snapshot))
      const original = [await disk(snapshotPath), await disk(historyPath)]
      const guard = guarded(path)
      try {
        const results = [
          await guard.harness.completed!(guard.input).catch((error: unknown) => error),
          await guard.harness.run(guard.input).catch((error: unknown) => error),
        ]
        expect(results).toEqual([
          new Error('Invalid native run snapshot'),
          new Error('Invalid native run snapshot'),
        ])
        expect(guard.calls).toEqual({
          checkpoints: 0,
          providers: 0,
          models: 0,
          reservations: 0,
          http: 0,
          tools: 0,
        })
        expect([await disk(snapshotPath), await disk(historyPath)]).toEqual(original)
      } finally {
        guard.restore()
      }
    }))
}

test('snapshot identity mismatch retains priority over invalid state and completion', () =>
  fixture(async ({ path, snapshotPath, historyPath, snapshot }) => {
    await writeJSON(snapshotPath, {
      ...snapshot,
      nativeSessionID: 'other',
      state: null,
      completion: null,
    })
    const original = [await disk(snapshotPath), await disk(historyPath)]
    const guard = guarded(path)
    try {
      expect(await guard.harness.completed!(guard.input).catch((e: unknown) => e)).toEqual(
        new Error('Native session identity mismatch'),
      )
      expect(await guard.harness.run(guard.input).catch((e: unknown) => e)).toEqual(
        new Error('Native session identity mismatch'),
      )
      expect(guard.calls).toEqual({
        checkpoints: 0,
        providers: 0,
        models: 0,
        reservations: 0,
        http: 0,
        tools: 0,
      })
      expect([await disk(snapshotPath), await disk(historyPath)]).toEqual(original)
    } finally {
      guard.restore()
    }
  }))

for (const legacy of [false, true]) {
  test(`valid completed snapshot replays opaque SDK state spend-free without rewriting${legacy ? ' legacy UUID history' : ''}`, () =>
    fixture(async ({ path, snapshotPath, historyPath, snapshot }) => {
      await writeJSON(snapshotPath, { ...snapshot, state: 'private SDK state never copied to SQL' })
      if (legacy) {
        const history = JSON.parse(await readFile(historyPath, 'utf8')) as {
          items: unknown[]
          admittedRuns?: string[]
        }
        history.items.unshift({
          type: 'message',
          role: 'user',
          id: '12345678-1234-1234-1234-123456789abc',
          content: 'legacy',
        })
        delete history.admittedRuns
        await writeJSON(historyPath, history)
      }
      const original = [await disk(snapshotPath), await disk(historyPath)]
      const guard = guarded(path)
      try {
        expect(await guard.harness.completed!(guard.input)).toEqual({
          text: 'done',
          sources: [],
          assets: [],
        })
        expect(await guard.harness.run(guard.input)).toEqual({
          text: 'done',
          sources: [],
          assets: [],
        })
        expect(guard.calls).toEqual({
          checkpoints: 1,
          providers: 0,
          models: 0,
          reservations: 0,
          http: 0,
          tools: 0,
        })
        expect([await disk(snapshotPath), await disk(historyPath)]).toEqual(original)
      } finally {
        guard.restore()
      }
    }))
}

test('pending real SDK snapshot without input admission rejects before provider lookup without rewriting', () =>
  fixture(async ({ path, snapshotPath, historyPath, snapshot }) => {
    delete snapshot.completion
    await writeJSON(snapshotPath, snapshot)
    const history = JSON.parse(await readFile(historyPath, 'utf8')) as { admittedRuns?: string[] }
    delete history.admittedRuns
    await writeJSON(historyPath, history)
    const original = [await disk(snapshotPath), await disk(historyPath)]
    const guard = guarded(path)
    try {
      expect(await guard.harness.completed!(guard.input)).toBeUndefined()
      expect(await guard.harness.run(guard.input).catch((e: unknown) => e)).toEqual(
        new Error('Missing native input admission; explicit recovery required'),
      )
      expect(guard.calls).toEqual({
        checkpoints: 0,
        providers: 0,
        models: 0,
        reservations: 0,
        http: 0,
        tools: 0,
      })
      expect([await disk(snapshotPath), await disk(historyPath)]).toEqual(original)
    } finally {
      guard.restore()
    }
  }))

test('completed lookup accepts the opaque PostgreSQL receipt fixture without history or spend', () =>
  fixture(async ({ path, snapshotPath, historyPath }) => {
    await rm(historyPath)
    await writeJSON(snapshotPath, {
      nativeSessionID: 'native',
      state: 'private SDK state never copied to SQL',
      sources: [],
      assets: [],
      completion: { text: 'Durable native answer' },
    })
    const original = await disk(snapshotPath)
    const guard = guarded(path)
    try {
      expect(await guard.harness.completed!({ ...guard.input, requireExisting: false })).toEqual({
        text: 'Durable native answer',
      })
      expect(guard.calls).toEqual({
        checkpoints: 0,
        providers: 0,
        models: 0,
        reservations: 0,
        http: 0,
        tools: 0,
      })
      expect(await disk(snapshotPath)).toEqual(original)
      expect(await stat(historyPath).catch((e: unknown) => e)).toHaveProperty('code', 'ENOENT')
    } finally {
      guard.restore()
    }
  }))

test('valid populated snapshot returns original public facts without normalization or disk writes', () =>
  fixture(async ({ path, snapshotPath, historyPath, snapshot }) => {
    const sources = [{ title: 'Public title', url: 'https://example.com/public' }]
    const assets = [
      {
        assetID: '12345678-1234-4234-8234-123456789ABC',
        objectKey: 'opaque-business-fact',
        name: 'out.png',
        mimeType: 'image/png',
        byteLength: 1,
        sha256: 'a'.repeat(64),
      },
    ]
    const completion = { text: 'done', sources, assets }
    await writeJSON(snapshotPath, {
      ...snapshot,
      state: 'private SDK state never copied to SQL',
      sources,
      assets,
      completion,
    })
    const original = [await disk(snapshotPath), await disk(historyPath)]
    const guard = guarded(path)
    try {
      expect(await guard.harness.completed!(guard.input)).toEqual(completion)
      expect(await guard.harness.run(guard.input)).toEqual(completion)
      expect(guard.calls).toEqual({
        checkpoints: 1,
        providers: 0,
        models: 0,
        reservations: 0,
        http: 0,
        tools: 0,
      })
      expect([await disk(snapshotPath), await disk(historyPath)]).toEqual(original)
    } finally {
      guard.restore()
    }
  }))

test('absent snapshot lookup respects existing-history authority without creating files', () =>
  fixture(async ({ path, snapshotPath, historyPath }) => {
    await rm(snapshotPath)
    const original = await disk(historyPath)
    const guard = guarded(path)
    try {
      expect(
        await guard.harness.completed!({ ...guard.input, requireExisting: true }),
      ).toBeUndefined()
      expect(await disk(historyPath)).toEqual(original)
      await rm(historyPath)
      expect(
        await guard.harness.completed!({ ...guard.input, requireExisting: false }),
      ).toBeUndefined()
      expect(
        await guard.harness.completed!({ ...guard.input, requireExisting: true }).catch(
          (e: unknown) => e,
        ),
      ).toHaveProperty('name', 'NativeStateLostError')
      expect(await stat(snapshotPath).catch((e: unknown) => e)).toHaveProperty('code', 'ENOENT')
      expect(await stat(historyPath).catch((e: unknown) => e)).toHaveProperty('code', 'ENOENT')
      expect(guard.calls).toEqual({
        checkpoints: 0,
        providers: 0,
        models: 0,
        reservations: 0,
        http: 0,
        tools: 0,
      })
    } finally {
      guard.restore()
    }
  }))
