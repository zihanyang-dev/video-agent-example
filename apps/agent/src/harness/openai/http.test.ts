import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenAIHarness } from './adapter.ts'
import { FileSession } from './session.ts'

/** Real HTTP and official OpenAI client/Responses adapter; no external network. */
async function fixture(body: (path: string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), 'openai-http-test-'))
  try {
    await body(path)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
}

const request = {
  engine: 'openai' as const,
  threadID: 'thread',
  runID: 'run',
  nativeSessionID: 'native',
  text: 'original',
  tools: {
    execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    read: async () => '',
    write: async () => {},
  },
  signal: new AbortController().signal,
  beforeModel: async () => {},
  checkpoint: async () => {},
  onText: () => {},
}

function options(statePath: string, baseURL: string) {
  return {
    statePath,
    baseURL,
    key: 'nonsecret-controlled-key',
    modelID: 'gpt-controlled',
    contextWindow: 10000,
    maxOutputTokens: 100,
    reasoning: 'low' as const,
    input: ['text'],
    systemPrompt: 'test',
  }
}

function sse() {
  const item = {
    id: 'msg-controlled',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'done', annotations: [] }],
  }
  const response = {
    id: 'resp-controlled',
    object: 'response',
    status: 'completed',
    output: [item],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  }
  return new Response(
    [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item },
      {
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: 'done',
      },
      { type: 'response.completed', response },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

test('actual HTTP dispatch is denied with no provider request or retries', () =>
  fixture(async (path) => {
    let received = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        received++
        return sse()
      },
    })
    try {
      let gates = 0
      await Promise.resolve(
        expect(
          createOpenAIHarness(options(path, server.url.href)).run({
            ...request,
            beforeModel: async () => {
              gates++
              throw new Error('dispatch denied')
            },
          }),
        ).rejects.toThrow(),
      )
      expect(gates).toBe(1)
      expect(received).toBe(0)
    } finally {
      await server.stop(true)
    }
  }))

test('official HTTP model streams text with store false and no trace requests', () =>
  fixture(async (path) => {
    const bodies: Record<string, unknown>[] = []
    const paths: string[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        paths.push(new URL(req.url).pathname)
        bodies.push((await req.json()) as Record<string, unknown>)
        return sse()
      },
    })
    try {
      let text = ''
      let gates = 0
      const result = await createOpenAIHarness(options(path, server.url.href)).run({
        ...request,
        initialContext: {
          version: 1,
          throughRunID: '11111111-1111-4111-8111-111111111111',
          turns: [
            {
              runID: '11111111-1111-4111-8111-111111111111',
              input: {
                messageID: '22222222-2222-4222-8222-222222222222',
                text: 'Earlier question',
              },
              output: { messageID: '33333333-3333-4333-8333-333333333333', text: 'Earlier answer' },
            },
          ],
        },
        beforeModel: async () => {
          gates++
        },
        onText: (delta) => {
          text += delta
        },
      })
      expect(result.text).toBe('done')
      expect(text).toBe('done')
      expect(gates).toBe(1)
      expect(paths).toEqual(['/responses'])
      expect(bodies[0]?.store).toBe(false)
      const input = bodies[0]?.input as { role?: string; id?: string }[]
      const original = input.find((item) => item.role === 'user')
      expect(original).toBeDefined()
      expect(original).not.toHaveProperty('id')
      expect(input.map((item) => item.role)).toEqual(['user', 'assistant', 'user'])
      expect(JSON.stringify(input[1])).toContain('Earlier answer')
      expect(JSON.stringify(input)).not.toContain('11111111-1111-4111-8111-111111111111')
      for (const item of input) expect(item).not.toHaveProperty('id')
      expect(bodies[0]?.max_output_tokens).toBe(100)
      expect(bodies[0]?.reasoning).toEqual({ effort: 'low' })
    } finally {
      await server.stop(true)
    }
  }))

test('official compaction uses locally stored native items and atomically persists native marker', () =>
  fixture(async (path) => {
    const paths: string[] = []
    let compactBody: Record<string, unknown> | undefined
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        paths.push(new URL(req.url).pathname)
        if (new URL(req.url).pathname.endsWith('/compact')) {
          compactBody = (await req.json()) as Record<string, unknown>
          return Response.json({
            id: 'cmp-controlled',
            object: 'response.compaction',
            created_at: 1,
            output: [
              { type: 'compaction', id: 'cmp-item', encrypted_content: 'opaque-native-marker' },
            ],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          })
        }
        return sse()
      },
    })
    try {
      let gates = 0
      const result = await createOpenAIHarness({
        ...options(path, server.url.href),
        contextWindow: 1,
      }).run({
        ...request,
        beforeModel: async () => {
          gates++
        },
      })
      expect(result.text).toBe('done')
      expect(paths).toEqual(['/responses', '/responses/compact'])
      expect(gates).toBe(2)
      expect(compactBody?.previous_response_id).toBeUndefined()
      expect(Array.isArray(compactBody?.input)).toBe(true)
      const reopened = new FileSession(join(path, 'openai/thread/session.json'), 'native', true)
      await reopened.retainInput(request.runID, request.text, true)
      const items = await reopened.getItems()
      expect(items).toContainEqual({
        type: 'compaction',
        id: 'cmp-item',
        encrypted_content: 'opaque-native-marker',
      })
    } finally {
      await server.stop(true)
    }
  }))

test('compaction authorization failure cannot be swallowed into successful completion', () =>
  fixture(async (path) => {
    let compactRequests = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req) => {
        if (new URL(req.url).pathname.endsWith('/compact')) {
          compactRequests++
          throw new Error('must not dispatch')
        }
        return sse()
      },
    })
    try {
      let gates = 0
      await Promise.resolve(
        expect(
          createOpenAIHarness({ ...options(path, server.url.href), contextWindow: 1 }).run({
            ...request,
            beforeModel: async () => {
              if (++gates === 2) throw new Error('compact denied')
            },
          }),
        ).rejects.toThrow('Connection error.'),
      )
      expect(compactRequests).toBe(0)
    } finally {
      await server.stop(true)
    }
  }))
