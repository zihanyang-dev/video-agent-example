import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model } from '@openai/agents'
import { NativeOwnerUnsettledError } from '../../contract.ts'
import { createOpenAIHarness } from './adapter.ts'

for (const final of [undefined, 'done', ''] as const) {
  test(`native ${final === undefined ? 'AbortError without owner cancellation is not completion' : `string final ${JSON.stringify(final)} is durable`}`, async () => {
    const statePath = await mkdtemp(join(tmpdir(), 'owned-openai-final-'))
    const controller = new AbortController()
    let admissions = 0
    let modelCalls = 0
    let modelSettled = false
    const model: Model = {
      async getResponse() {
        throw new Error('Unexpected nonstream call')
      },
      async *getStreamedResponse() {
        modelCalls++
        try {
          if (final === undefined) throw new DOMException('Model aborted', 'AbortError')
          yield {
            type: 'response_done',
            response: {
              id: 'final',
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: final }],
                },
              ],
            },
          }
        } finally {
          modelSettled = true
        }
      },
    }
    const harness = createOpenAIHarness({
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
    const input = {
      engine: 'openai' as const,
      threadID: 'thread',
      nativeSessionID: 'native',
      runID: 'run',
      text: 'original',
      tools: {
        execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        read: async () => '',
        write: async () => {},
      },
      signal: controller.signal,
      beforeModel: async () => {
        admissions++
      },
      checkpoint: async () => {},
      onText: () => {},
    }
    try {
      const outcome = await harness.run(input).then(
        (completion) => ({ completion, error: undefined }),
        (error: unknown) => ({ completion: undefined, error }),
      )
      expect(controller.signal.aborted).toBe(false)
      expect(modelSettled).toBe(true)
      expect(admissions).toBe(1)
      expect(modelCalls).toBe(1)
      const snapshot = JSON.parse(
        await readFile(join(statePath, 'openai/thread/runs/run.json'), 'utf8'),
      )
      if (final === undefined) {
        // A joined native failure is not an unsettled physical writer or a durable success.
        expect(snapshot.completion).toBeUndefined()
        expect(outcome.error).toBeInstanceOf(Error)
        expect(outcome.error).not.toBeInstanceOf(NativeOwnerUnsettledError)
        expect(outcome.completion).toBeUndefined()
        expect(await harness.completed?.(input)).toBeUndefined()
      } else {
        expect(outcome.error).toBeUndefined()
        expect(outcome.completion?.text).toBe(final)
        expect(snapshot.completion.text).toBe(final)
        expect((await harness.completed?.(input))?.text).toBe(final)
        expect((await harness.run(input)).text).toBe(final)
        expect(admissions).toBe(1)
        expect(modelCalls).toBe(1)
      }
    } finally {
      await rm(statePath, { recursive: true, force: true })
    }
  })
}
