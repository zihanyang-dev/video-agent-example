import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenAIHarness } from './adapter'
import { FileSession, writeJSON } from './session'

test('private input admission survives reload and native compaction without provider IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'owned-openai-admission-'))
  const path = join(directory, 'session.json')
  try {
    const session = new FileSession(path, 'native')
    await Promise.all([
      session.retainInput('run', 'original'),
      session.retainInput('run', 'original'),
    ])
    expect(await session.getItems()).toEqual([
      { type: 'message', role: 'user', content: 'original' },
    ])
    const reopened = new FileSession(path, 'native', true)
    await reopened.retainInput('run', 'original', true)
    expect(await reopened.getItems()).toHaveLength(1)
    const compact = { type: 'compaction' as const, id: 'cmp-native', encrypted_content: 'opaque' }
    await reopened.replaceHistoryWithCompaction([compact])
    await new FileSession(path, 'native', true).retainInput('run', 'original', true)
    expect(await reopened.getItems()).toEqual([compact])
    await reopened.retainInput('next', 'follow-up')
    expect(await reopened.getItems()).toEqual([
      compact,
      { type: 'message', role: 'user', content: 'follow-up' },
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('legacy business input IDs and missing resumed admission fail without rewriting history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'owned-openai-legacy-input-'))
  const path = join(directory, 'session.json')
  try {
    const item = {
      type: 'message' as const,
      role: 'user' as const,
      id: '12345678-1234-1234-1234-123456789abc',
      content: 'original',
    }
    await writeJSON(path, { sessionID: 'native', items: [item] })
    const original = await readFile(path, 'utf8')
    await Promise.resolve(
      expect(
        new FileSession(path, 'native', true).retainInput('next', 'follow-up'),
      ).rejects.toThrow('offline migration'),
    )
    expect(await readFile(path, 'utf8')).toBe(original)
    await writeJSON(path, {
      sessionID: 'native',
      items: [{ type: 'message', role: 'user', content: 'original' }],
    })
    const unmarked = await readFile(path, 'utf8')
    await Promise.resolve(
      expect(
        new FileSession(path, 'native', true).retainInput('run', 'original', true),
      ).rejects.toThrow('explicit recovery'),
    )
    expect(await readFile(path, 'utf8')).toBe(unmarked)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('failed compaction comparison preserves original disk and blocks later admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'owned-openai-compaction-'))
  const path = join(directory, 'session.json')
  try {
    const session = new FileSession(path, 'native')
    await session.retainInput('run', 'original')
    const previous = await session.getItems()
    await session.addItems([{ type: 'message', role: 'user', content: 'later' }])
    const original = await readFile(path, 'utf8')
    await Promise.resolve(
      expect(session.replaceHistoryWithCompaction([], previous)).rejects.toThrow(
        'history retained',
      ),
    )
    expect(await readFile(path, 'utf8')).toBe(original)
    await Promise.resolve(expect(session.getSessionId()).rejects.toThrow('history retained'))
    await Promise.resolve(
      expect(session.retainInput('next', 'follow-up')).rejects.toThrow('history retained'),
    )
    expect(await readFile(path, 'utf8')).toBe(original)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

for (const items of [undefined, null, {}]) {
  test(`invalid persisted history (${JSON.stringify(items)}) cannot become an empty session`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owned-openai-format-'))
    const path = join(directory, 'session.json')
    try {
      await writeJSON(path, { sessionID: 'native', items })
      const original = await readFile(path, 'utf8')
      const session = new FileSession(path, 'native', true)
      const load = await session.getItems().catch((error: unknown) => error)
      expect(load).toEqual(new Error('Invalid native session history'))
      const mutation = await session
        .addItems([{ type: 'message', role: 'user', content: 'Must not replace history' }])
        .catch((error: unknown) => error)
      expect(mutation).toEqual(new Error('Invalid native session history'))
      expect(await readFile(path, 'utf8')).toBe(original)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('malformed initialized history rejects before native checkpoint or model admission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'owned-openai-format-run-'))
  const path = join(directory, 'openai', 'thread', 'session.json')
  let checkpoints = 0
  let reservations = 0
  try {
    await writeJSON(path, { sessionID: 'native' })
    const original = await readFile(path, 'utf8')
    const harness = createOpenAIHarness({
      statePath: directory,
      baseURL: 'http://127.0.0.1:1',
      key: 'fixture',
      modelID: 'gpt-controlled',
      contextWindow: 10000,
      maxOutputTokens: 100,
      reasoning: 'low',
      input: ['text'],
      systemPrompt: 'fixture',
    })
    const rejection = await harness
      .run({
        engine: 'openai',
        threadID: 'thread',
        nativeSessionID: 'native',
        requireExisting: true,
        runID: 'run',
        text: 'Must not erase history',
        tools: {
          execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
          read: async () => '',
          write: async () => {},
        },
        signal: AbortSignal.timeout(5000),
        checkpoint: async () => {
          checkpoints++
        },
        beforeModel: async () => {
          reservations++
          throw new Error('Unexpected model admission')
        },
        onText: () => {},
      })
      .catch((error: unknown) => error)
    expect(rejection).toEqual(new Error('Invalid native session history'))
    expect({ checkpoints, reservations }).toEqual({ checkpoints: 0, reservations: 0 })
    expect(await readFile(path, 'utf8')).toBe(original)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
