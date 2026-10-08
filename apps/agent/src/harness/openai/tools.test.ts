import { expect, test } from 'bun:test'
import { Agent, Runner, type Model, type ModelRequest, type FunctionCallItem } from '@openai/agents'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOpenAITools } from './tools.ts'
import { createOpenAIHarness } from './adapter.ts'
import type { FileTools } from '../../contract.ts'

function model(calls: FunctionCallItem[], observe: (request: ModelRequest) => void): Model {
  return {
    async getResponse() {
      throw new Error('unexpected')
    },

    async *getStreamedResponse(request) {
      observe(request)
      const finished =
        Array.isArray(request.input) && request.input.some((i) => i.type === 'function_call_result')
      yield {
        type: 'response_done',
        response: {
          id: finished ? 'done' : 'calls',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          output: finished
            ? [
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'done' }],
                },
              ]
            : calls,
        },
      }
    },
  }
}

const call = (name: string, args: object, id = name): FunctionCallItem => ({
  type: 'function_call',
  name,
  callId: id,
  arguments: JSON.stringify(args),
  status: 'completed',
})
const tools = {
  execute: async () => ({ stdout: 'out', stderr: 'err', exitCode: 7 }),
  read: async () => 'observed',
  write: async () => {},
}

const reference = {
  assetID: '01234567-89ab-4cde-8f01-23456789abcd',
  objectKey: 'opaque-business-fact',
  name: 'out.png',
  mimeType: 'image/png',
  byteLength: 1,
  sha256: 'a'.repeat(64),
}

const files: FileTools = {
  assigned: [],
  prepared: [],
  importFile: async () => ({ bytes: new Uint8Array([1]), mimeType: 'image/png' }),
  exportFile: async () => reference,
}

test('native import produces actual SDK image content and export output hides object identity', async () => {
  const requests: ModelRequest[] = []
  const agent = new Agent({
    name: 'native-tools',
    model: model(
      [
        call('import_file', { assetID: 'assigned', path: '/guest/img' }),
        call('export_file', { path: '/guest/out', name: 'out.png', mimeType: 'image/png' }),
      ],
      (request) => requests.push(request),
    ),
    tools: createOpenAITools({
      tools,
      fileTools: files,
      supportsImages: true,
      signal: new AbortController().signal,
      beforeTool: async () => {},
      onSources: () => {},
    }),
  })
  const result = await new Runner({ tracingDisabled: true }).run(agent, 'original', {
    stream: true,
  })
  for await (const _event of result) {
    /* ordinary native consumption */
  }
  await result.completed
  const input = requests[1]?.input
  expect(Array.isArray(input)).toBe(true)
  if (!Array.isArray(input)) throw new Error('missing native input')
  const outputs = input.filter((i) => i.type === 'function_call_result')
  expect(JSON.stringify(outputs)).toContain('data:image/png;base64,AQ==')
  expect(JSON.stringify(outputs)).toContain(reference.assetID)
  expect(JSON.stringify(outputs)).not.toContain('opaque-business-fact')
})

test('native search keeps shared sanitization, quota and source facts', async () => {
  let dispatched = 0
  const sources: unknown[] = []
  const requests: ModelRequest[] = []
  const agent = new Agent({
    name: 'search-tools',
    model: model(
      Array.from({ length: 4 }, (_, n) =>
        call('web_search', { query: 'public query' }, `search-${n}`),
      ),
      (request) => requests.push(request),
    ),
    tools: createOpenAITools({
      tools,
      supportsImages: false,
      signal: new AbortController().signal,
      beforeTool: async () => {},
      onSources: (found) => sources.push(...found),
      webSearch: {
        authMode: 'keyless',
        transport: async () => {
          dispatched++
          return Response.json({
            results: [
              {
                title: '<b>Public title</b>',
                url: 'https://example.com/public',
                content: '<script>secret</script>Public snippet',
              },
            ],
          })
        },
      },
    }),
  })
  const result = await new Runner({ tracingDisabled: true }).run(agent, 'original', {
    stream: true,
  })
  for await (const _event of result) {
    /* ordinary native consumption */
  }
  await result.completed
  expect(dispatched).toBe(3)
  expect(sources).toContainEqual({ title: 'Public title', url: 'https://example.com/public' })
  const serialized = JSON.stringify(requests[1]?.input)
  expect(serialized).toContain('Search limit reached')
  expect(serialized).toContain('Public snippet')
  expect(serialized).not.toContain('secret')
})

test('tool entry never acknowledges an SDK-uncommitted completed effect', async () => {
  const path = await mkdtemp(join(tmpdir(), 'openai-effect-test-'))
  let acknowledged = false
  let writes = 0
  try {
    const native = model(
      [
        call('write', { path: '/guest/file', content: 'value' }),
        call('read', { path: '/guest/file' }),
      ],
      () => {},
    )
    await createOpenAIHarness({
      statePath: path,
      baseURL: 'http://127.0.0.1:1',
      key: 'controlled',
      modelID: 'gpt-controlled',
      contextWindow: 1000,
      maxOutputTokens: 10,
      reasoning: 'low',
      input: ['text'],
      systemPrompt: 'test',
      model: native,
    }).run({
      engine: 'openai',
      threadID: 'thread',
      runID: 'run',
      nativeSessionID: 'native',
      text: 'original',
      signal: new AbortController().signal,
      beforeModel: async () => {},
      checkpoint: async () => {
        if (writes) acknowledged = true
      },
      onText: () => {},
      tools: {
        ...tools,
        write: async () => {
          writes++
          acknowledged = false
        },
        read: async () => {
          expect(acknowledged).toBe(false)
          return 'observed'
        },
      },
    })
    expect(writes).toBe(1)
    expect(acknowledged).toBe(true)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
})

test('SDK tool cancellation is joined before every capability or checkpoint', async () => {
  const { RunContext } = await import('@openai/agents')
  let entered = 0
  const native = createOpenAITools({
    tools,
    fileTools: files,
    webSearch: {
      authMode: 'keyless',
      transport: async () => {
        entered++
        return Response.json({ results: [] })
      },
    },
    supportsImages: false,
    signal: new AbortController().signal,
    beforeTool: async () => {
      entered++
    },
    onSources: () => {},
  })
  const aborted = AbortSignal.abort(new Error('SDK cancelled'))
  const inputs: Record<string, object> = {
    execute: { command: 'cmd' },
    read: { path: '/guest' },
    write: { path: '/guest', content: 'text' },
    import_file: { assetID: 'assigned', path: '/guest' },
    export_file: { path: '/guest', name: 'out', mimeType: 'text/plain' },
    web_search: { query: 'public query' },
  }
  for (const definition of native) {
    if (definition.type !== 'function') throw new Error('unexpected ambient tool')
    await Promise.resolve(
      expect(
        definition.invoke(new RunContext(), JSON.stringify(inputs[definition.name]), {
          signal: aborted,
        }),
      ).rejects.toThrow('SDK cancelled'),
    )
  }
  expect(entered).toBe(0)
})

test('terminal native cache retains exported asset and public source facts with fresh capabilities', async () => {
  const path = await mkdtemp(join(tmpdir(), 'openai-facts-test-'))
  const prepared: (typeof reference)[] = []
  const perRunFiles: FileTools = {
    ...files,
    prepared,
    exportFile: async () => {
      prepared.push(reference)
      return reference
    },
  }
  const search = {
    authMode: 'keyless' as const,
    transport: async () =>
      Response.json({
        results: [
          { title: 'Public title', url: 'https://example.com/public', content: 'public evidence' },
        ],
      }),
  }
  const options = {
    statePath: path,
    baseURL: 'http://127.0.0.1:1',
    key: 'controlled',
    modelID: 'gpt-controlled',
    contextWindow: 1000,
    maxOutputTokens: 10,
    reasoning: 'low' as const,
    input: ['text'],
    systemPrompt: 'test',
    webSearch: search,
  }
  const request = {
    engine: 'openai' as const,
    threadID: 'thread',
    runID: 'run',
    nativeSessionID: 'native',
    text: 'original',
    signal: new AbortController().signal,
    beforeModel: async () => {},
    checkpoint: async () => {},
    onText: () => {},
    tools,
    fileTools: perRunFiles,
  }
  try {
    const original = await createOpenAIHarness({
      ...options,
      model: model(
        [
          call('export_file', { path: '/guest/out', name: 'out.png', mimeType: 'image/png' }),
          call('web_search', { query: 'public query' }),
        ],
        () => {},
      ),
    }).run(request)
    expect(original.assets).toEqual([reference])
    expect(original.sources).toEqual([{ title: 'Public title', url: 'https://example.com/public' }])
    const cached = await createOpenAIHarness({
      ...options,
      model: model([], () => {
        throw new Error('must not infer')
      }),
    }).run({
      ...request,
      fileTools: {
        ...files,
        prepared: [],
        exportFile: async () => {
          throw new Error('must not export again')
        },
      },
    })
    expect(cached).toEqual(original)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
})
