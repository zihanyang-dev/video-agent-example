import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSession } from '@earendil-works/pi-coding-agent'
import { NativeOwnerUnsettledError } from '../../contract'
import { createPiHarness } from './adapter'

for (const scenario of ['deadline', 'rejected', '401'] as const) {
  test(`real Native SDK abort ownership: ${scenario}`, async () => {
    const statePath = await mkdtemp(join(tmpdir(), 'owned-native-unsettled-'))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const producerDone = Promise.withResolvers<void>()
    const abortReceipts: Promise<void>[] = []
    // Called with the original session receiver below.
    // oxlint-disable-next-line typescript/unbound-method
    const originalAbort = AgentSession.prototype.abort
    const receiptFailure = new Error('Rejected owned abort receipt')
    const abortSpy = spyOn(AgentSession.prototype, 'abort').mockImplementation(function (
      this: AgentSession,
    ) {
      const receipt = originalAbort.call(this)
      abortReceipts.push(receipt)
      void receipt.catch(() => {})
      return scenario === 'rejected' ? Promise.reject(receiptFailure) : receipt
    })
    let requests = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        requests++
        if (scenario === '401') return new Response('unauthorized', { status: 401 })
        const choices = [
          {
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call',
                  type: 'function',
                  function: { name: 'execute', arguments: JSON.stringify({ command: 'gated' }) },
                },
              ],
            },
            finish_reason: null,
          },
          { delta: {}, finish_reason: 'tool_calls' },
        ]
        return new Response(
          choices
            .map(
              (choice) =>
                `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, ...choice }] })}\n\n`,
            )
            .join('') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    const owner = new AbortController()
    const harness = createPiHarness({
      statePath,
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      key: 'fixture',
      modelID: 'fixture',
      contextWindow: 16384,
      maxOutputTokens: 512,
      reasoning: false,
      input: ['text'],
      systemPrompt: 'Use assigned tools.',
    })
    const run = harness
      .run({
        engine: 'pi',
        threadID: crypto.randomUUID(),
        nativeSessionID: crypto.randomUUID(),
        runID: crypto.randomUUID(),
        text: 'execute',
        signal: owner.signal,
        beforeModel: async () => {},
        checkpoint: async () => {},
        onText: () => {},
        tools: {
          execute: async () => {
            entered.resolve()
            try {
              await release.promise
              return { stdout: '', stderr: '', exitCode: 0 }
            } finally {
              producerDone.resolve()
            }
          },
          read: async () => '',
          write: async () => {},
        },
      })
      .catch((error: unknown) => error)
    // The watchdog owns and joins its producer; no fixture callback is detached.
    const watchdog = setTimeout(() => {
      owner.abort()
      release.resolve()
    }, 18000)
    try {
      if (scenario !== '401') {
        await entered.promise
        owner.abort(new Error('product cancellation'))
      }
      const error = await run
      expect(error).toBeInstanceOf(Error)
      if (scenario === '401') expect(error).not.toBeInstanceOf(NativeOwnerUnsettledError)
      else {
        expect(error).toBeInstanceOf(NativeOwnerUnsettledError)
        expect(requests).toBe(1)
      }
      if (scenario === 'rejected') expect((error as Error).cause).toBe(receiptFailure)
    } finally {
      clearTimeout(watchdog)
      owner.abort()
      release.resolve()
      if (scenario !== '401') await producerDone.promise
      await Promise.allSettled(abortReceipts)
      await run
      abortSpy.mockRestore()
      await server.stop(true)
      await rm(statePath, { recursive: true, force: true })
    }
  }, 20000)
}
