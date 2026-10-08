import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenAIHarness } from './adapter.ts'

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

test('compaction checkpoint failure prevents HTTP dispatch', () =>
  fixture(async (path) => {
    let compactRequests = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req) => {
        if (new URL(req.url).pathname.endsWith('/compact')) {
          compactRequests++
          return Response.json({
            id: 'cmp-controlled',
            object: 'response.compaction',
            created_at: 1,
            output: [{ type: 'compaction', id: 'cmp-item', encrypted_content: 'opaque' }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          })
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
            checkpoint: async () => {
              if (++gates === 2) throw new Error('checkpoint denied')
            },
          }),
        ).rejects.toThrow(),
      )
      expect(compactRequests).toBe(0)
    } finally {
      await server.stop(true)
    }
  }))
