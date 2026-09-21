import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemorySandbox } from '../../../../../tests/fixtures/sandbox'
import { startPiHarness } from './pi'
import type { Observation } from '../../domain/progress'

const fixture = async (respond: () => Response) => {
  const host = await mkdtemp(join(tmpdir(), 'vid-pi-test-'))
  const model = Bun.serve({ port: 0, fetch: respond })
  const observations: Observation[] = []
  const harness = await startPiHarness({
    sandbox: createMemorySandbox(host),
    model: {
      id: 'test-model',
      apiKey: 'local-test',
      baseUrl: `${model.url.href}v1`,
      contextWindow: 128000,
      maxTokens: 1000,
    },
    skills: [],
    systemPrompt: 'Respond briefly.',
    history: [],
    turnID: 'test-turn',
    onObservation: (observation) => observations.push(observation),
  })

  return {
    harness,
    observations,
    close: async () => {
      harness.dispose()
      await model.stop(true)
      await rm(host, { recursive: true, force: true })
    },
  }
}

const reply = (): Response => {
  const chunk = (delta: object, finish_reason: string | null) =>
    `data: ${JSON.stringify({
      id: 'chat-test',
      object: 'chat.completion.chunk',
      model: 'test-model',
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`

  return new Response(
    chunk({ role: 'assistant', content: 'Hello' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

const withHarness = async (
  respond: () => Response,
  assertion: (context: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
): Promise<void> => {
  const context = await fixture(respond)
  try {
    await assertion(context)
  } finally {
    await context.close()
  }
}

test('the real pi adapter emits execution progress and retains model history', async () => {
  await withHarness(reply, async ({ harness, observations }) => {
    await harness.run('Hello')
    await harness.flush()

    expect(observations).toContainEqual({
      kind: 'text-delta',
      channel: 'assistant',
      messageID: expect.any(String),
      delta: 'Hello',
    })
    expect(harness.entries().length).toBeGreaterThan(0)
  })
})

test('a provider rejection is a failed run even when pi stores it as an assistant message', async () => {
  const rejected = () =>
    Response.json(
      { error: { message: 'invalid model', type: 'invalid_request_error' } },
      { status: 400 },
    )
  await withHarness(rejected, async ({ harness }) => {
    await expect(harness.run('Hello')).rejects.toThrow('invalid model')
  })
})

test('steering queued after an idle reply is consumed by flush', async () => {
  await withHarness(reply, async ({ harness }) => {
    await harness.run('Hello')
    await harness.steer('Use blue')
    await harness.flush()

    expect(JSON.stringify(harness.entries())).toContain('Use blue')
  })
})
