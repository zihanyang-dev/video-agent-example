import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model } from '@openai/agents'
import { NativeOwnerUnsettledError } from '../../contract'
import { createOpenAIHarness } from './adapter'

for (const settlement of ['joined', 'deadline'] as const) {
  test(`text observer failure retains native model ownership until ${settlement}`, async () => {
    const statePath = await mkdtemp(join(tmpdir(), 'owned-openai-join-'))
    const observed = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const modelDone = Promise.withResolvers<void>()
    const failure = new Error('Observer failed')
    let returned = false
    const model: Model = {
      async getResponse() {
        throw new Error('Unexpected nonstream call')
      },
      async *getStreamedResponse() {
        try {
          yield { type: 'output_text_delta', delta: 'partial' }
          await release.promise
        } finally {
          modelDone.resolve()
        }
      },
    }
    const run = createOpenAIHarness({
      statePath,
      model,
      baseURL: 'http://127.0.0.1:1',
      key: 'fixture',
      modelID: 'fixture',
      contextWindow: 10000,
      maxOutputTokens: 100,
      reasoning: 'low',
      input: ['text'],
      systemPrompt: 'fixture',
    })
      .run({
        engine: 'openai',
        threadID: 'thread',
        nativeSessionID: 'native',
        runID: 'run',
        text: 'original',
        tools: {
          execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
          read: async () => '',
          write: async () => {},
        },
        signal: new AbortController().signal,
        beforeModel: async () => {},
        checkpoint: async () => {},
        onText: () => {
          observed.resolve()
          throw failure
        },
      })
      .catch((error: unknown) => {
        returned = true
        return error
      })
    try {
      await observed.promise
      await Bun.sleep(25)
      expect(returned).toBe(false)
      if (settlement === 'joined') {
        release.resolve()
        expect(await run).toBe(failure)
        await modelDone.promise
      } else {
        expect(await run).toBeInstanceOf(NativeOwnerUnsettledError)
      }
    } finally {
      release.resolve()
      await run
      await modelDone.promise
      await rm(statePath, { recursive: true, force: true })
    }
  }, 15000)
}
