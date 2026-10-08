import { expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeStateLostError, type SandboxTools } from '../../contract'
import { createPiHarness } from './adapter'

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

for (const fault of ['file', 'directory'] as const) {
  for (const operation of ['completed', 'resume', 'next-turn'] as const) {
    test(`initialized Pi ${fault} loss rejects ${operation} without recreating history`, async () => {
      const statePath = await mkdtemp(join(tmpdir(), 'owned-pi-state-loss-'))
      const threadID = crypto.randomUUID()
      const nativeSessionID = crypto.randomUUID()
      const runID = crypto.randomUUID()
      const nativeDirectory = join(statePath, 'pi', threadID)
      let requests = 0
      let reservations = 0
      const provider = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch() {
          requests++
          return new Response(
            'data: ' +
              JSON.stringify({
                id: 'owned',
                object: 'chat.completion.chunk',
                model: 'owned-model',
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant', content: 'Original completion' },
                    finish_reason: null,
                  },
                ],
              }) +
              '\n\n' +
              'data: ' +
              JSON.stringify({
                id: 'owned',
                object: 'chat.completion.chunk',
                model: 'owned-model',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              }) +
              '\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          )
        },
      })
      const options = {
        statePath,
        key: 'owned-state-loss-key',
        modelID: 'owned-model',
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
        contextWindow: 16384,
        maxOutputTokens: 512,
        reasoning: false,
        input: ['text'] as ('text' | 'image')[],
        systemPrompt: 'Use only assigned tools.',
      }
      const request = {
        engine: 'pi' as const,
        threadID,
        nativeSessionID,
        runID,
        text: 'Complete the original request.',
        tools,
        signal: new AbortController().signal,
        onText() {},
        async checkpoint() {},
        async beforeModel() {
          reservations++
        },
      }
      try {
        // A genuinely new SQL identity may allocate its first native journal.
        expect(await createPiHarness(options).run(request)).toEqual({
          text: 'Original completion',
          sources: [],
        })
        const identity = {
          engine: 'pi' as const,
          threadID,
          nativeSessionID,
          runID,
          requireExisting: true,
        }
        expect(await createPiHarness(options).completed!(identity)).toBeDefined()
        const files = await readdir(nativeDirectory)
        expect(files.filter((file) => file.endsWith('.jsonl'))).toHaveLength(1)
        if (fault === 'directory') await rm(nativeDirectory, { recursive: true })
        else
          await rm(
            join(
              nativeDirectory,
              files.find((file) => file.endsWith('.jsonl'))!,
            ),
          )

        const restored = createPiHarness(options)
        const attempted =
          operation === 'completed'
            ? restored.completed!(identity)
            : restored.run({
                ...request,
                runID: operation === 'resume' ? runID : crypto.randomUUID(),
                requireExisting: true,
              })
        expect(await attempted.catch((error: unknown) => error)).toBeInstanceOf(
          NativeStateLostError,
        )
        expect(requests).toBe(1)
        expect(reservations).toBe(1)
        expect(await readdir(nativeDirectory).catch((error: unknown) => error)).toEqual(
          fault === 'file' ? [] : expect.any(Error),
        )
      } finally {
        await provider.stop(true)
        await rm(statePath, { recursive: true, force: true })
      }
    })
  }
}
