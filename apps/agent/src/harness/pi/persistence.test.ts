import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { createPiHarness } from './adapter'
import type { SandboxTools } from '../../contract'

const settings = {
  key: 'owned-persistence-key',
  modelID: 'owned-model',
  contextWindow: 16384,
  maxOutputTokens: 512,
  reasoning: false,
  input: ['text'] as ('text' | 'image')[],
  systemPrompt: 'Use only assigned remote tools.',
}

const stream = (delta: unknown, finishReason: string) =>
  new Response(
    [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: finishReason },
    ]
      .map(
        (choice) =>
          `data: ${JSON.stringify({ id: 'owned', object: 'chat.completion.chunk', model: settings.modelID, choices: [{ index: 0, ...choice }] })}\n\n`,
      )
      .join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )

test('retains native input and completed tool result when the original request fails later', async () => {
  const statePath = await mkdtemp(join(tmpdir(), 'owned-native-pi-'))
  const threadID = crypto.randomUUID()
  const runID = crypto.randomUUID()
  const nativeDirectory = join(statePath, 'pi', threadID)
  await mkdir(nativeDirectory, { recursive: true })
  const requests: { messages: unknown[] }[] = []
  let reads = 0
  const tools: SandboxTools = {
    async read({ path }) {
      expect(path).toBe('/workspace/notes.txt')
      reads++
      return 'Original inspected workspace value'
    },
    async execute() {
      throw new Error('Unexpected command')
    },
    async write() {
      throw new Error('Unexpected write')
    },
  }
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe('Bearer owned-persistence-key')
      requests.push((await request.json()) as { messages: unknown[] })
      if (requests.length === 1)
        return stream(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'original-read',
                type: 'function',
                function: { name: 'read', arguments: '{"path":"/workspace/notes.txt"}' },
              },
            ],
          },
          'tool_calls',
        )
      if (requests.length === 2) return new Response('Controlled rejection', { status: 401 })
      if (requests.length === 3)
        return stream(
          { role: 'assistant', content: 'Continued with the saved inspection.' },
          'stop',
        )
      return new Response('Unexpected model request', { status: 500 })
    },
  })
  const options = { ...settings, statePath, baseURL: `http://127.0.0.1:${provider.port}/v1` }
  const input = {
    engine: 'pi' as const,
    threadID,
    nativeSessionID: threadID,
    runID,
    text: 'Inspect notes and finish the task.',
    tools,
    signal: new AbortController().signal,
    onText() {},
    async beforeModel() {},
    async checkpoint() {},
  }
  try {
    expect(
      await createPiHarness(options)
        .run(input)
        .catch((error: unknown) => error),
    ).toBeInstanceOf(Error)
    expect(reads).toBe(1)
    const files = (await readdir(nativeDirectory)).filter((file) => file.endsWith('.jsonl'))
    expect(files).toHaveLength(1)
    const manager = SessionManager.open(join(nativeDirectory, files[0]!))
    expect(manager.getSessionId()).toBe(threadID)
    const messages = manager
      .getBranch()
      .flatMap((entry) => (entry.type === 'message' ? [entry.message] : []))
    expect(
      messages.some(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content).includes('Inspect notes and finish the task.'),
      ),
    ).toBe(true)
    expect(
      messages.some(
        (message) =>
          message.role === 'toolResult' &&
          message.toolCallId === 'original-read' &&
          JSON.stringify(message.content).includes('Original inspected workspace value'),
      ),
    ).toBe(true)
    const continuedInput = {
      ...input,
      runID: crypto.randomUUID(),
      text: 'Continue after the provider rejection.',
    }
    const next = await createPiHarness(options).run(continuedInput)
    expect(next.text).toBe('Continued with the saved inspection.')
    expect(JSON.stringify(requests[2]!.messages)).toContain('Original inspected workspace value')
    expect(JSON.stringify(requests[2]!.messages)).toContain('Inspect notes and finish the task.')
    expect(reads).toBe(1)
    const reopened = SessionManager.open(join(nativeDirectory, files[0]!))
    expect(reopened.getSessionId()).toBe(threadID)
  } finally {
    await provider.stop(true)
    await rm(statePath, { recursive: true, force: true })
  }
}, 15000)
