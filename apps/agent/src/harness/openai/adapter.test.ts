import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model, ModelRequest } from '@openai/agents'
import { FileSession } from './session.ts'
import { createOpenAIHarness } from './adapter.ts'

const tools = {
  execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  read: async () => 'observed',
  write: async () => {},
}

function controlled(onRequest: (request: ModelRequest) => void = () => {}): Model {
  return {
    async getResponse() {
      throw new Error('Unexpected nonstream call')
    },

    async *getStreamedResponse(request) {
      onRequest(request)
      const hasResult =
        Array.isArray(request.input) && request.input.some((i) => i.type === 'function_call_result')
      yield {
        type: 'response_done',
        response: {
          id: hasResult ? 'final' : 'tool',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          output: hasResult
            ? [
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'done' }],
                },
              ]
            : [
                {
                  type: 'function_call',
                  callId: 'read-1',
                  name: 'read',
                  arguments: '{"path":"/guest/file"}',
                  status: 'completed',
                },
              ],
        },
      }
    },
  }
}

async function fixture(body: (path: string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), 'native-openai-test-'))
  try {
    await body(path)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
}

const options = (statePath: string, model: Model) => ({
  statePath,
  model,
  modelID: 'gpt-controlled',
  baseURL: 'http://127.0.0.1:1',
  key: 'controlled',
  contextWindow: 10000,
  maxOutputTokens: 100,
  reasoning: 'low' as const,
  input: ['text'] as const,
  systemPrompt: 'test',
})
const request = {
  engine: 'openai' as const,
  threadID: 'thread',
  nativeSessionID: 'native',
  runID: 'run',
  text: 'original',
  tools,
  signal: new AbortController().signal,
  beforeModel: async () => {},
  checkpoint: async () => {},
  onText: () => {},
}

test('FileSession stores SDK items verbatim and preserves identity', () =>
  fixture(async (path) => {
    const session = new FileSession(join(path, 'session.json'), 'native')
    const item = {
      type: 'message' as const,
      role: 'user' as const,
      id: 'run',
      content: 'original',
    }
    await session.addItems([item])
    expect(await new FileSession(join(path, 'session.json'), 'native').getItems()).toEqual([item])
    expect(await session.getItems(0)).toEqual([])
    await Promise.resolve(
      expect(new FileSession(join(path, 'session.json'), 'other').getItems()).rejects.toThrow(
        'identity',
      ),
    )
  }))

test('terminal ACK loss returns cached completion with no model or repeated tool', () =>
  fixture(async (path) => {
    let reads = 0
    let calls = 0
    const input = {
      ...request,
      tools: {
        ...tools,
        read: async () => {
          reads++
          return 'observed'
        },
      },
      checkpoint: async () => {
        if (calls === 2) throw new Error('ACK lost')
      },
    }
    await Promise.resolve(
      expect(
        createOpenAIHarness(
          options(
            path,
            controlled(() => {
              calls++
            }),
          ),
        ).run(input),
      ).rejects.toThrow('ACK lost'),
    )
    expect(reads).toBe(1)
    const completion = await createOpenAIHarness(
      options(
        path,
        controlled(() => {
          throw new Error('must not dispatch')
        }),
      ),
    ).run(request)
    expect(completion.text).toBe('done')
    expect(reads).toBe(1)
    const session = new FileSession(join(path, 'openai/thread/session.json'), 'native')
    expect(
      (await session.getItems()).filter((item) => item.type === 'message' && item.role === 'user'),
    ).toHaveLength(1)
    expect(
      JSON.parse(await readFile(join(path, 'openai/thread/runs/run.json'), 'utf8')).state,
    ).toBeString()
  }))

test('next-model checkpoint restores completed readonly result without replay', () =>
  fixture(async (path) => {
    let reads = 0
    let gates = 0
    const input = {
      ...request,
      tools: {
        ...tools,
        read: async () => {
          reads++
          return 'observed'
        },
      },
      beforeModel: async () => {
        if (++gates === 2) throw new Error('stop before second dispatch')
      },
    }
    await Promise.resolve(
      expect(createOpenAIHarness(options(path, controlled())).run(input)).rejects.toThrow(
        'stop before second dispatch',
      ),
    )
    let restoredInput: ModelRequest['input'] = ''
    expect(
      (
        await createOpenAIHarness(
          options(
            path,
            controlled((r) => {
              restoredInput = r.input
            }),
          ),
        ).run({ ...request, tools: input.tools })
      ).text,
    ).toBe('done')
    expect(reads).toBe(1)
    expect(
      Array.isArray(restoredInput) &&
        restoredInput.filter((item) => item.type === 'message' && item.role === 'user'),
    ).toHaveLength(1)
  }))

test('authorization rejection never enters injected provider', () =>
  fixture(async (path) => {
    let calls = 0
    await Promise.resolve(
      expect(
        createOpenAIHarness(
          options(
            path,
            controlled(() => {
              calls++
            }),
          ),
        ).run({
          ...request,
          beforeModel: async () => {
            throw new Error('denied')
          },
        }),
      ).rejects.toThrow('denied'),
    )
    expect(calls).toBe(0)
  }))

test('oversized native text events fail before public observation', () =>
  fixture(async (path) => {
    const native: Model = {
      async getResponse() {
        throw new Error('unexpected')
      },
      async *getStreamedResponse() {
        yield { type: 'output_text_delta', delta: 'x'.repeat(2 * 1024 * 1024 + 1) }
        yield {
          type: 'response_done',
          response: {
            id: 'done',
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            output: [
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'done' }],
              },
            ],
          },
        }
      },
    }
    let observed = 0
    await Promise.resolve(
      expect(
        createOpenAIHarness(options(path, native)).run({
          ...request,
          onText: (delta) => {
            observed += delta.length
          },
        }),
      ).rejects.toThrow('budget'),
    )
    expect(observed).toBe(0)
  }))

test('engine mismatch fails closed before native admission or provider dispatch', () =>
  fixture(async (path) => {
    await Promise.resolve(
      expect(
        createOpenAIHarness(
          options(
            path,
            controlled(() => {
              throw new Error('must not infer')
            }),
          ),
        ).run({ ...request, engine: 'pi' }),
      ).rejects.toThrow('engine'),
    )
  }))
