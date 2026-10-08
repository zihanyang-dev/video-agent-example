import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPiHarness } from './adapter'
import { openPiSession } from './session'

for (const result of [null, { text: 42 }, { text: 'done', assets: [null] }]) {
  test(`malformed durable Pi completion rejects both entrypoints without admission (${JSON.stringify(result)})`, async () => {
    const statePath = await mkdtemp(join(tmpdir(), 'owned-pi-completion-format-'))
    const identity = {
      engine: 'pi' as const,
      threadID: crypto.randomUUID(),
      nativeSessionID: crypto.randomUUID(),
      runID: crypto.randomUUID(),
      requireExisting: true,
    }
    let admissions = 0
    try {
      const manager = await openPiSession(statePath, identity.threadID, identity.nativeSessionID)
      manager.appendMessage({ role: 'user', content: 'Original task', timestamp: Date.now() })
      manager.appendCustomEntry('platform-completed', { runID: identity.runID, result })
      const path = manager.getSessionFile()!
      const original = await readFile(path, 'utf8')
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
      const refuse = async (): Promise<never> => {
        admissions++
        throw new Error('Unexpected admission')
      }
      await Promise.resolve(
        expect(harness.completed!(identity)).rejects.toThrow('Invalid native Pi completion'),
      )
      await Promise.resolve(
        expect(
          harness.run({
            ...identity,
            text: 'Must not repeat completed work',
            signal: new AbortController().signal,
            beforeModel: refuse,
            checkpoint: refuse,
            onText: () => {},
            tools: { execute: refuse, read: refuse, write: refuse },
          }),
        ).rejects.toThrow('Invalid native Pi completion'),
      )
      expect(admissions).toBe(0)
      expect(await readFile(path, 'utf8')).toBe(original)
    } finally {
      await rm(statePath, { recursive: true, force: true })
    }
  })
}
