import { expect, test } from 'bun:test'
import {
  parseSessionEntries,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { SandboxTools } from '../execute-run.ts'
import { restorePiHistory } from './pi-history.ts'
import type { WebSearchConfig } from './web-search'
import { createPiHarness } from './pi.ts'

const options = {
  key: 'fixture-only-key',
  modelID: 'fixture-model',
  contextWindow: 16384,
  maxOutputTokens: 512,
  reasoning: true,
  input: ['text'] as ('text' | 'image')[],
  systemPrompt: 'PRIVATE SYSTEM: use only assigned sandbox tools.',
}

type RequestBody = {
  model: string
  messages: unknown[]
  tools: { function: { name: string } }[]
  max_tokens?: number
  max_completion_tokens?: number
}

function fixture(responses: Record<string, unknown>[][]) {
  const requests: RequestBody[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe(
        'Bearer fixture-only-key',
      )
      requests.push((await request.json()) as RequestBody)
      const chunks = responses.shift()
      if (!chunks) return new Response('unexpected request', { status: 500 })
      return new Response(
        chunks
          .map(
            (chunk) =>
              `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: options.modelID, choices: [{ index: 0, ...chunk }] })}\n\n`,
          )
          .join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  return {
    requests,
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    close: () => server.stop(true),
  }
}

const answer = (text: string) => [
  {
    delta: {
      role: 'assistant',
      reasoning_content: 'PRIVATE THINKING',
      content: text,
    },
    finish_reason: null,
  },
  { delta: {}, finish_reason: 'stop' },
]
const calls = (tools: { name: string; args: unknown }[]) => [
  {
    delta: {
      role: 'assistant',
      tool_calls: tools.map((tool, index) => ({
        index,
        id: `call-${index}`,
        type: 'function',
        function: { name: tool.name, arguments: JSON.stringify(tool.args) },
      })),
    },
    finish_reason: null,
  },
  { delta: {}, finish_reason: 'tool_calls' },
]

function sandbox() {
  const files = new Map<string, string>()
  const commands: string[] = []
  const signals: AbortSignal[] = []
  const tools: SandboxTools = {
    async execute({ command, signal }) {
      signals.push(signal)
      commands.push(command)
      return { stdout: 'PRIVATE STDOUT', stderr: '', exitCode: 0 }
    },
    async read({ path, signal }) {
      signals.push(signal)
      return files.get(path) ?? 'PRIVATE READ'
    },
    async write({ path, content, signal }) {
      signals.push(signal)
      files.set(path, content)
    },
  }
  return { tools, files, commands, signals }
}

function pendingSandbox() {
  let toolStarted!: () => void
  const started = new Promise<void>((resolve) => {
    toolStarted = resolve
  })
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let acknowledgeAbort!: () => void
  const aborted = new Promise<void>((resolve) => {
    acknowledgeAbort = resolve
  })
  let sawAbort = false
  let settled = false
  const assigned = sandbox()
  assigned.tools.execute = async ({ signal }) => {
    signal.addEventListener(
      'abort',
      () => {
        sawAbort = true
        acknowledgeAbort()
      },
      { once: true },
    )
    toolStarted()
    await released
    settled = true
    signal.throwIfAborted()
    return { stdout: '', stderr: '', exitCode: 0 }
  }
  return {
    assigned,
    started,
    aborted,
    release,
    get sawAbort() {
      return sawAbort
    },
    get settled() {
      return settled
    },
  }
}

test('canonical answer is the final native assistant message, not tool-turn narration', async () => {
  const tool = calls([{ name: 'read', args: { path: '/notes.txt' } }])
  const final = '  Final answer with exact whitespace.\n'
  const provider = fixture([
    [
      {
        ...tool[0],
        delta: { ...tool[0]!.delta, content: 'Checking the assigned notes. ' },
      },
      ...tool.slice(1),
    ],
    answer(final),
  ])
  try {
    const deltas: string[] = []
    const result = await createPiHarness({
      ...options,
      baseURL: provider.baseURL,
    }).turn({
      text: 'Answer after checking notes',
      history: null,
      tools: sandbox().tools,
      signal: AbortSignal.timeout(5000),
      onText: (delta) => deltas.push(delta),
    })
    expect(result.text).toBe(final)
    expect(deltas.join('')).toBe('Checking the assigned notes. ' + final)
    expect(JSON.stringify(result.history)).toContain(
      'Checking the assigned notes.',
    )
    expect(JSON.stringify(result.history)).toContain('PRIVATE READ')
    expect(result.text).not.toContain('PRIVATE THINKING')
    expect(provider.requests).toHaveLength(2)
  } finally {
    await provider.close()
  }
})

test('streams only assistant text and restores canonical private history in a fresh harness', async () => {
  const provider = fixture([answer('Hello'), answer('Again')])
  try {
    const deltas: string[] = []
    const input = {
      text: 'first',
      history: null,
      tools: sandbox().tools,
      signal: new AbortController().signal,
      onText: (text: string) => deltas.push(text),
    }
    const first = await createPiHarness({
      ...options,
      baseURL: provider.baseURL,
    }).turn(input)
    expect(first.text).toBe('Hello')
    expect(deltas.join('')).toBe('Hello')
    const restored = JSON.parse(JSON.stringify(first.history)) as {
      header: { id: string }
      entries: unknown[]
      leafID: string
    }
    expect(restored.header.id).toBeString()
    expect(restored.entries.length).toBeGreaterThan(0)
    expect(restored.leafID).toBeString()
    const second = await createPiHarness({
      ...options,
      baseURL: provider.baseURL,
    }).turn({ ...input, text: 'second', history: restored })
    expect(second.text).toBe('Again')
    const snapshot = second.history as typeof restored
    expect(snapshot.header).toEqual(restored.header)
    expect(snapshot.entries.slice(0, restored.entries.length)).toEqual(
      restored.entries,
    )
    const request = provider.requests[1]!
    expect(JSON.stringify(request.messages)).toContain('first')
    expect(JSON.stringify(request.messages)).toContain('Hello')
    expect(request.model).toBe(options.modelID)
    expect(
      provider.requests[0]!.tools.map((tool) => tool.function.name).sort(),
    ).toEqual(['execute', 'read', 'write'])
    expect(JSON.stringify(provider.requests[0]!.messages)).toContain(
      options.systemPrompt,
    )
    expect(deltas.join('')).not.toContain('PRIVATE')
  } finally {
    await provider.close()
  }
})

test('executes only assigned sandbox tools with private results and meaningful side effects', async () => {
  const provider = fixture([
    calls([
      { name: 'write', args: { path: '/work/video.txt', content: 'video' } },
    ]),
    calls([
      { name: 'read', args: { path: '/work/video.txt' } },
      { name: 'execute', args: { command: 'render video' } },
    ]),
    answer('Rendered'),
  ])
  const assigned = sandbox()
  const deltas: string[] = []
  try {
    const result = await createPiHarness({
      ...options,
      baseURL: provider.baseURL,
    }).turn({
      text: 'render',
      history: null,
      tools: assigned.tools,
      signal: new AbortController().signal,
      onText: (text) => deltas.push(text),
    })
    expect(assigned.files.get('/work/video.txt')).toBe('video')
    expect(assigned.commands).toEqual(['render video'])
    expect(assigned.signals).toHaveLength(3)
    expect(
      assigned.signals.every((signal) => signal instanceof AbortSignal),
    ).toBe(true)
    expect(result.text).toBe('Rendered')
    expect(deltas.join('')).toBe('Rendered')
    expect(JSON.stringify(provider.requests[2]!.messages)).toContain(
      'PRIVATE STDOUT',
    )
    expect(JSON.stringify(result.history)).toContain('PRIVATE STDOUT')
  } finally {
    await provider.close()
  }
})

test('pre-aborted turns do not contact the provider', async () => {
  const provider = fixture([answer('unexpected')])
  try {
    const controller = new AbortController()
    controller.abort()
    expect(
      createPiHarness({ ...options, baseURL: provider.baseURL }).turn({
        text: 'no',
        history: null,
        tools: sandbox().tools,
        signal: controller.signal,
        onText: () => {},
      }),
    ).rejects.toThrow()
    expect(provider.requests).toHaveLength(0)
  } finally {
    await provider.close()
  }
})

test('cancellation waits for the sandbox tool to settle before returning', async () => {
  const provider = fixture([
    calls([{ name: 'execute', args: { command: 'long render' } }]),
  ])
  const controller = new AbortController()
  const pending = pendingSandbox()
  const deltas: string[] = []
  let outcome: Promise<void> | undefined
  try {
    let returned = false
    const turn = createPiHarness({
      ...options,
      baseURL: provider.baseURL,
    }).turn({
      text: 'render',
      history: null,
      tools: pending.assigned.tools,
      signal: controller.signal,
      onText: (text) => deltas.push(text),
    })
    outcome = turn.then(
      () => {
        returned = true
      },
      () => {
        returned = true
      },
    )
    await pending.started
    controller.abort()
    await pending.aborted
    expect(pending.sawAbort).toBe(true)
    await Bun.sleep(25)
    expect(returned).toBe(false)
    pending.release()
    await outcome
    expect(pending.settled).toBe(true)
    expect(turn).rejects.toThrow()
    expect(deltas).toEqual([])
    expect(provider.requests).toHaveLength(1)
  } finally {
    controller.abort()
    pending.release()
    await outcome
    await provider.close()
  }
})

async function seededHistory() {
  const provider = fixture([answer('Previous')])
  try {
    const result = await createPiHarness({
      ...options,
      baseURL: provider.baseURL,
    }).turn({
      text: 'previous request',
      history: null,
      tools: sandbox().tools,
      signal: new AbortController().signal,
      onText: () => {},
    })
    return JSON.parse(JSON.stringify(result.history)) as {
      header: Record<string, unknown>
      entries: Record<string, unknown>[]
      leafID: string | null
    }
  } finally {
    await provider.close()
  }
}

for (const stopReason of ['aborted', 'error']) {
  test(`a successful current invocation ignores a historical ${stopReason} assistant`, async () => {
    const history = await seededHistory()
    const assistant = history.entries.find(
      (entry) =>
        entry.type === 'message' &&
        (entry.message as { role: string }).role === 'assistant',
    )!
    Object.assign(assistant.message as object, {
      stopReason,
      errorMessage: 'old failure',
    })
    const provider = fixture([answer('Current success')])
    try {
      const result = await createPiHarness({
        ...options,
        baseURL: provider.baseURL,
      }).turn({
        text: 'retry',
        history,
        tools: sandbox().tools,
        signal: new AbortController().signal,
        onText: () => {},
      })
      expect(result.text).toBe('Current success')
      expect(JSON.stringify(result.history)).toContain('old failure')
    } finally {
      await provider.close()
    }
  })
}

test('restores an empty SQL history array as a fresh session', () => {
  const manager = restorePiHistory([])
  expect(manager.getEntries()).toEqual([])
  expect(manager.getLeafId()).toBeNull()
  expect(manager.buildSessionContext().messages).toEqual([])
})

for (const history of [[null], [{ type: 'session' }]]) {
  test(`rejects nonempty history array ${JSON.stringify(history)} before SDK traversal`, () => {
    expect(() => restorePiHistory(history)).toThrow(
      'Invalid private Pi history',
    )
  })
}

test('restores SDK context without imposing provider metadata requirements', () => {
  const manager = SessionManager.inMemory()
  manager.appendMessage({ role: 'user', content: 'request', timestamp: 1 })
  const history = {
    header: manager.getHeader(),
    entries: [
      ...manager.getEntries(),
      {
        type: 'message',
        id: 'assistant',
        parentId: manager.getLeafId(),
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: null },
      },
    ],
    leafID: 'assistant',
  }
  const restored = restorePiHistory(history)
  expect(JSON.stringify(restored.getEntries())).toBe(
    JSON.stringify(history.entries),
  )
  expect(JSON.stringify(restored.buildSessionContext().messages.at(-1))).toBe(
    JSON.stringify({ role: 'assistant', content: [] }),
  )
})

const invalidHistories: Record<
  string,
  (history: Awaited<ReturnType<typeof seededHistory>>) => void
> = {
  'self cycle': (history) => {
    history.entries.at(-1)!.parentId = history.entries.at(-1)!.id
  },
  'two-node cycle': (history) => {
    history.entries.at(-1)!.parentId = history.entries.at(-2)!.id
    history.entries.at(-2)!.parentId = history.entries.at(-1)!.id
  },
  'inactive cycle': (history) => {
    history.entries.push({
      type: 'session_info',
      id: 'inactive',
      parentId: 'inactive',
      timestamp: new Date().toISOString(),
    })
  },
  'duplicate ID': (history) => {
    history.entries.push(structuredClone(history.entries[0]!))
  },
  'missing parent': (history) => {
    history.entries.at(-1)!.parentId = 'absent'
  },
  'missing leaf': (history) => {
    history.leafID = 'absent'
  },
  'bad header': (history) => {
    history.header.cwd = 42
  },
  'missing message': (history) => {
    delete history.entries.at(-1)!.message
  },
  'null entry': (history) => {
    history.entries.push(null as unknown as Record<string, unknown>)
  },
  'bad system sections': (history) => {
    const entry = history.entries.find(
      (entry) =>
        entry.type === 'message' &&
        (entry.message as { role: string }).role === 'system',
    )!
    Object.assign(entry.message as object, { sections: { broken: 42 } })
  },
  'bad content': (history) => {
    ;(history.entries.at(-1)!.message as { content: unknown }).content = 42
  },
}

for (const [name, corrupt] of Object.entries(invalidHistories)) {
  test(`rejects ${name} before SDK traversal or provider access (bounded subprocess)`, async () => {
    const history = await seededHistory()
    corrupt(history)
    const provider = fixture([answer('must not run')])
    try {
      const script = `
        import type { WebSearchConfig } from './web-search'
import { createPiHarness } from ${JSON.stringify(new URL('./pi.ts', import.meta.url).pathname)};
        try {
          await createPiHarness(${JSON.stringify({ ...options, baseURL: provider.baseURL })}).turn({
            history: ${JSON.stringify(history)}, text: 'invalid',
            signal: AbortSignal.timeout(100), onText() {},
            tools: { async execute() { throw Error('unexpected tool') }, async read() { throw Error('unexpected tool') }, async write() { throw Error('unexpected tool') } }
          });
          console.log('ACCEPTED');
        } catch (error) { console.log(error.message) }
      `
      const child = Bun.spawn([process.execPath, '--eval', script], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 1500,
        killSignal: 'SIGKILL',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(stdout.trim()).toStartWith('Invalid private Pi history')
      expect({ stderr, exitCode }).toEqual({ stderr: '', exitCode: 0 })
      expect(provider.requests).toHaveLength(0)
    } finally {
      await provider.close()
    }
  }, 10000)
}

async function branchedHistory() {
  const seed = await seededHistory()
  const manager = SessionManager.inMemory(
    '/fixture',
    undefined,
    parseSessionEntries(
      [seed.header, ...seed.entries]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    ),
  )
  const fork = manager.getLeafId()!
  manager.appendMessage({
    role: 'user',
    content: 'ABANDONED REQUEST',
    timestamp: 1,
  })
  manager.branch(fork)
  const kept = manager.appendMessage({
    role: 'user',
    content: 'KEPT REQUEST',
    timestamp: 2,
  })
  manager.appendCompaction('COMPACTED SUMMARY', kept, 123)
  manager.appendCustomEntry('fixture', { private: 'metadata' })
  manager.appendCustomMessageEntry('fixture-context', 'CUSTOM CONTEXT', false)
  manager.appendLabelChange(kept, 'bookmark')
  manager.appendContextEdit(kept, { content: 'EDITED REQUEST' })
  const selected = manager.getLeafId()!
  manager.resetLeaf()
  manager.appendMessage({ role: 'user', content: 'OTHER ROOT', timestamp: 3 })
  manager.branch(selected)
  return {
    header: manager.getHeader(),
    entries: manager.getEntries(),
    leafID: manager.getLeafId(),
  }
}

test('preserves the full canonical branched tree while projecting only the selected compacted branch', async () => {
  const history = await branchedHistory()
  const provider = fixture([answer('Branch answer')])
  try {
    const result = await createPiHarness({
      ...options,
      baseURL: provider.baseURL,
    }).turn({
      text: 'continue selected',
      history: JSON.parse(JSON.stringify(history)),
      tools: sandbox().tools,
      signal: new AbortController().signal,
      onText: () => {},
    })
    expect(result.text).toBe('Branch answer')
    const restored = result.history as typeof history
    expect(restored.header).toEqual(history.header)
    expect(restored.entries.slice(0, history.entries.length)).toEqual(
      history.entries,
    )
    const messages = JSON.stringify(provider.requests[0]!.messages)
    expect(messages).toContain('COMPACTED SUMMARY')
    expect(messages).toContain('EDITED REQUEST')
    expect(messages).toContain('CUSTOM CONTEXT')
    expect(messages).not.toContain('ABANDONED REQUEST')
    expect(messages).not.toContain('OTHER ROOT')
    expect(messages).not.toContain('previous request')
    expect(messages).not.toContain('KEPT REQUEST')
  } finally {
    await provider.close()
  }
})

test('a null active leaf preserves existing entries but starts a new root', async () => {
  const history = await seededHistory()
  history.leafID = null
  const provider = fixture([answer('New root')])
  try {
    const result = await createPiHarness({
      ...options,
      baseURL: provider.baseURL,
    }).turn({
      text: 'new root request',
      history,
      tools: sandbox().tools,
      signal: new AbortController().signal,
      onText: () => {},
    })
    expect(result.text).toBe('New root')
    const restored = result.history as typeof history
    expect(restored.entries.slice(0, history.entries.length)).toEqual(
      history.entries,
    )
    expect(restored.entries[history.entries.length]!.parentId).toBeNull()
    expect(JSON.stringify(provider.requests[0]!.messages)).not.toContain(
      'previous request',
    )
  } finally {
    await provider.close()
  }
})

test('a current provider failure is rejected even when history has a successful assistant', async () => {
  const history = await seededHistory()
  const provider = fixture([])
  try {
    expect(
      createPiHarness({ ...options, baseURL: provider.baseURL }).turn({
        text: 'fail now',
        history,
        tools: sandbox().tools,
        signal: new AbortController().signal,
        onText: () => {},
      }),
    ).rejects.toThrow('Pi model execution failed')
    expect(provider.requests).toHaveLength(1)
  } finally {
    await provider.close()
  }
})

test('assigned image bytes reach the official model HTTP image payload and private replay', async () => {
  const provider = fixture([
    calls([
      {
        name: 'import_file',
        args: {
          assetID: '11111111-1111-4111-8111-111111111111',
          path: '/chosen',
        },
      },
    ]),
    answer('Seen'),
    answer('Again'),
  ])
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64',
  )
  const input = {
    text: 'Inspect',
    history: null,
    tools: sandbox().tools,
    signal: AbortSignal.timeout(5000),
    onText: () => {},
    fileTools: {
      assigned: [],
      prepared: [],
      hasUnknownOutcome: () => false,
      importFile: async () => ({ bytes, mimeType: 'image/png' }),
      exportFile: async () => {
        throw new Error('Unexpected export')
      },
    },
  }
  try {
    const harness = createPiHarness({
      ...options,
      input: ['text', 'image'],
      baseURL: provider.baseURL,
    })
    const first = await harness.turn(input)
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
      `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
    )
    await harness.turn({
      ...input,
      text: 'Continue',
      history: JSON.parse(JSON.stringify(first.history)),
    })
    expect(JSON.stringify(provider.requests[2]?.messages)).toContain(
      `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
    )
  } finally {
    await provider.close()
  }
})

test('text-only assigned models receive staged-file instructions without an image modality', async () => {
  const provider = fixture([answer('Use tools')])
  try {
    await createPiHarness({ ...options, baseURL: provider.baseURL }).turn({
      text: 'Inspect assigned file /home/user/materials/photo.png with tools',
      history: null,
      tools: sandbox().tools,
      signal: AbortSignal.timeout(5000),
      onText: () => {},
    })
    expect(JSON.stringify(provider.requests[0]?.messages)).not.toContain(
      'image_url',
    )
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain(
      '/home/user/materials/photo.png',
    )
  } finally {
    await provider.close()
  }
})

test('explicit assigned image import delivers official image content only for a supported model', async () => {
  const provider = fixture([
    calls([
      {
        name: 'import_file',
        args: {
          assetID: '11111111-1111-4111-8111-111111111111',
          path: '/home/user/chosen-photo',
        },
      },
    ]),
    answer('Seen'),
  ])
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64',
  )
  try {
    const result = await createPiHarness({
      ...options,
      input: ['text', 'image'],
      baseURL: provider.baseURL,
    }).turn({
      text: 'Import the assigned photo',
      history: null,
      tools: sandbox().tools,
      signal: AbortSignal.timeout(5000),
      onText: () => {},
      fileTools: {
        assigned: [],
        prepared: [],
        hasUnknownOutcome: () => false,
        importFile: async ({ assetID, path }) => {
          expect({ assetID, path }).toEqual({
            assetID: '11111111-1111-4111-8111-111111111111',
            path: '/home/user/chosen-photo',
          })
          return { bytes, mimeType: 'image/png' }
        },
        exportFile: async () => {
          throw new Error('Unexpected export')
        },
      },
    })
    expect(result.text).toBe('Seen')
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
      `data:image/png;base64,${bytes.toString('base64')}`,
    )
  } finally {
    await provider.close()
  }
})

for (const [mimeType, input] of [
  ['image/png', ['text']],
  ['video/mp4', ['text', 'image']],
] as const) {
  test(`explicit ${mimeType} import for ${input.join('/')} does not consume bytes for image encoding`, async () => {
    const provider = fixture([
      calls([
        {
          name: 'import_file',
          args: {
            assetID: '11111111-1111-4111-8111-111111111111',
            path: '/chosen',
          },
        },
      ]),
      answer('Use tools'),
    ])
    let byteReads = 0
    try {
      const result = await createPiHarness({
        ...options,
        input,
        baseURL: provider.baseURL,
      }).turn({
        text: 'Import',
        history: null,
        tools: sandbox().tools,
        signal: AbortSignal.timeout(5000),
        onText: () => {},
        fileTools: {
          assigned: [],
          prepared: [],
          hasUnknownOutcome: () => false,
          importFile: async () => ({
            get bytes() {
              byteReads++
              return new Uint8Array([0, 255])
            },
            mimeType,
          }),
          exportFile: async () => {
            throw new Error('Unexpected export')
          },
        },
      })
      expect(result.text).toBe('Use tools')
      expect(provider.requests).toHaveLength(2)
      expect(JSON.stringify(provider.requests[1]?.messages)).not.toContain(
        'image_url',
      )
      expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
        'Use tools to inspect',
      )
      expect(byteReads).toBe(0)
    } finally {
      await provider.close()
    }
  })
}

test('native web_search loopback HTTP evidence is canonical and restored without redispatch', async () => {
  let searches = 0
  const search = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      searches++
      expect(request.headers.get('X-Tavily-Access-Mode')).toBe('keyless')
      expect(await request.json()).toMatchObject({
        query: 'public facts',
        search_depth: 'basic',
      })
      return Response.json({
        results: [
          {
            title: '<b>Public source</b>',
            url: 'https://example.org/source',
            content: 'Quoted evidence',
          },
        ],
      })
    },
  })
  const provider = fixture([
    calls([{ name: 'web_search', args: { query: 'public facts' } }]),
    answer('Source: https://example.org/source'),
    answer('Remembered'),
  ])
  const webSearch = {
    authMode: 'keyless' as const,
    transport: ((url, init) => {
      expect(url).toBe('https://api.tavily.com/search')
      return fetch(`http://127.0.0.1:${search.port}/search`, init)
    }) as NonNullable<WebSearchConfig['transport']>,
  }
  const input = {
    text: 'research',
    history: null,
    tools: sandbox().tools,
    signal: AbortSignal.timeout(5000),
    onText: (_text: string) => {},
  }
  try {
    const first = await createPiHarness({
      ...options,
      baseURL: provider.baseURL,
      webSearch,
    }).turn(input)
    expect(first.text).toBe('Source: https://example.org/source')
    expect(first.sources).toEqual([
      { title: 'Public source', url: 'https://example.org/source' },
    ])
    expect(JSON.stringify(first.sources)).not.toContain('Quoted evidence')
    expect(
      provider.requests[0]!.tools.map((tool) => tool.function.name).sort(),
    ).toEqual(['execute', 'read', 'web_search', 'write'])
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain(
      'Quoted evidence',
    )
    expect(JSON.stringify(first.history)).toContain('web_search')
    const second = await createPiHarness({
      ...options,
      baseURL: provider.baseURL,
      webSearch,
    }).turn({
      ...input,
      text: 'continue',
      history: JSON.parse(JSON.stringify(first.history)),
    })
    expect(JSON.stringify(provider.requests[2]!.messages)).toContain(
      'Quoted evidence',
    )
    expect(searches).toBe(1)
    expect(second.sources).toEqual([])
  } finally {
    await provider.close()
    await search.stop(true)
  }
})

test('native search TypeBox rejects malformed input without provider dispatch', async () => {
  const provider = fixture([
    calls([{ name: 'web_search', args: { query: { invalid: true } } }]),
    answer('Unavailable'),
  ])
  let searches = 0
  try {
    await createPiHarness({
      ...options,
      baseURL: provider.baseURL,
      webSearch: {
        authMode: 'keyless',
        transport: (async () => {
          searches++
          return Response.json({ results: [] })
        }) as NonNullable<WebSearchConfig['transport']>,
      },
    }).turn({
      text: 'search',
      history: null,
      tools: sandbox().tools,
      signal: AbortSignal.timeout(5000),
      onText: () => {},
    })
    expect(searches).toBe(0)
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain('query')
  } finally {
    await provider.close()
  }
})

test('owner cancellation waits for native web_search body cleanup without publishing tool data', async () => {
  const provider = fixture([
    calls([{ name: 'web_search', args: { query: 'private-query-fixture' } }]),
  ])
  let started!: () => void
  let release!: () => void
  let acknowledgeAbort!: () => void
  const aborted = new Promise<void>((resolve) => {
    acknowledgeAbort = resolve
  })
  let sawAbort = false
  const start = new Promise<void>((resolve) => {
    started = resolve
  })
  const cleanup = new Promise<void>((resolve) => {
    release = resolve
  })
  const owner = new AbortController()
  const reason = new Error('lease lost')
  const deltas: string[] = []
  let outcome: Promise<void> | undefined
  try {
    const turn = createPiHarness({
      ...options,
      baseURL: provider.baseURL,
      webSearch: {
        authMode: 'keyless',
        transport: (async (_url, init) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              sawAbort = true
              acknowledgeAbort()
            },
            { once: true },
          )
          return new Response(
            new ReadableStream({
              start() {
                started()
              },
              async cancel() {
                await cleanup
              },
            }),
          )
        }) as NonNullable<WebSearchConfig['transport']>,
      },
    }).turn({
      text: 'research',
      history: null,
      tools: sandbox().tools,
      signal: owner.signal,
      onText: (text) => deltas.push(text),
    })
    let settled = false
    outcome = turn.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await start
    owner.abort(reason)
    await aborted
    expect(sawAbort).toBe(true)
    await Bun.sleep(20)
    expect(settled).toBe(false)
    release()
    await outcome
    expect(turn).rejects.toBe(reason)
    expect(deltas).toEqual([])
    expect(provider.requests).toHaveLength(1)
  } finally {
    owner.abort(reason)
    release()
    await outcome
    await provider.close()
  }
})

test('ordinary remote search failure is sanitized tool evidence, not a failed sandbox turn', async () => {
  const provider = fixture([
    calls([{ name: 'web_search', args: { query: 'public facts' } }]),
    answer('Search unavailable'),
  ])
  const assigned = sandbox()
  const deltas: string[] = []
  let searches = 0
  try {
    const result = await createPiHarness({
      ...options,
      baseURL: provider.baseURL,
      webSearch: {
        authMode: 'key',
        apiKey: 'fixture-search-key',
        transport: (async () => {
          searches++
          throw new Error('PRIVATE provider body fixture-search-key')
        }) as NonNullable<WebSearchConfig['transport']>,
      },
    }).turn({
      text: 'research',
      history: null,
      tools: assigned.tools,
      signal: AbortSignal.timeout(5000),
      onText: (text) => deltas.push(text),
    })
    expect(result.text).toBe('Search unavailable')
    expect(deltas.join('')).toBe('Search unavailable')
    expect(assigned.commands).toEqual([])
    expect(searches).toBe(1)
    const replay = JSON.stringify(result.history)
    expect(replay).toContain('Web search unavailable.')
    expect(replay).not.toContain('fixture-search-key')
    expect(replay).not.toContain('PRIVATE provider body')
    expect(JSON.stringify(provider.requests[1]!.messages)).not.toContain(
      'PRIVATE provider body',
    )
  } finally {
    await provider.close()
  }
})

test('native search loop enforces three dispatched calls and renews quota only next turn', async () => {
  const provider = fixture([
    calls(
      Array.from({ length: 4 }, () => ({
        name: 'web_search',
        args: { query: 'public facts' },
      })),
    ),
    answer('Done'),
    calls([{ name: 'web_search', args: { query: 'new public facts' } }]),
    answer('New turn'),
  ])
  let searches = 0
  const harness = createPiHarness({
    ...options,
    baseURL: provider.baseURL,
    webSearch: {
      authMode: 'keyless',
      transport: (async () => {
        searches++
        return Response.json({ results: [] })
      }) as NonNullable<WebSearchConfig['transport']>,
    },
  })
  const input = {
    text: 'research',
    history: null,
    tools: sandbox().tools,
    signal: AbortSignal.timeout(5000),
    onText: () => {},
  }
  try {
    const first = await harness.turn(input)
    expect(searches).toBe(3)
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain(
      'Search limit reached for this turn.',
    )
    await harness.turn({
      ...input,
      text: 'new turn',
      history: JSON.parse(JSON.stringify(first.history)),
    })
    expect(searches).toBe(4)
  } finally {
    await provider.close()
  }
})

test('native turn source collection is bounded to fifteen actual results, not final-text URLs', async () => {
  const provider = fixture([
    calls(
      Array.from({ length: 3 }, () => ({
        name: 'web_search',
        args: { query: 'public facts' },
      })),
    ),
    answer('Invented URL https://uncaptured.example.org/'),
  ])
  let searches = 0
  try {
    const result = await createPiHarness({
      ...options,
      baseURL: provider.baseURL,
      webSearch: {
        authMode: 'keyless',
        transport: async () => {
          const search = searches++
          return Response.json({
            results: Array.from({ length: 8 }, (_, index) => ({
              title: `Found ${search}-${index}`,
              url: `https://example.org/${search}/${index}`,
              content: 'PRIVATE SNIPPET CANARY',
            })),
          })
        },
      },
    }).turn({
      text: 'research',
      history: null,
      tools: sandbox().tools,
      signal: AbortSignal.timeout(5000),
      onText: () => {},
    })
    expect(result.sources).toHaveLength(15)
    expect(result.sources).toEqual(
      Array.from({ length: 3 }, (_, search) =>
        Array.from({ length: 5 }, (_, index) => ({
          title: `Found ${search}-${index}`,
          url: `https://example.org/${search}/${index}`,
        })),
      ).flat(),
    )
    expect(JSON.stringify(result.sources)).not.toContain('PRIVATE')
    expect(JSON.stringify(result.sources)).not.toContain('uncaptured')
  } finally {
    await provider.close()
  }
})

test('native turn deduplicates normalized found URLs without retaining snippets', async () => {
  const provider = fixture([
    calls(
      Array.from({ length: 2 }, () => ({
        name: 'web_search',
        args: { query: 'public facts' },
      })),
    ),
    answer('Done'),
  ])
  try {
    const result = await createPiHarness({
      ...options,
      baseURL: provider.baseURL,
      webSearch: {
        authMode: 'keyless',
        transport: async () =>
          Response.json({
            results: [
              {
                title: 'Found',
                url: 'https://example.org',
                content: 'PRIVATE SNIPPET',
              },
            ],
          }),
      },
    }).turn({
      text: 'research',
      history: null,
      tools: sandbox().tools,
      signal: AbortSignal.timeout(5000),
      onText: () => {},
    })
    expect(result.sources).toEqual([
      { title: 'Found', url: 'https://example.org/' },
    ])
  } finally {
    await provider.close()
  }
})

function budgetResponses(scenario: string) {
  const call = (name: string, args: unknown) => calls([{ name, args }])
  switch (scenario) {
    case 'iterations':
      return [
        ...Array.from({ length: 17 }, () => call('read', { path: '/fixture' })),
        answer('unexpected'),
      ]
    case 'thinking':
      return [
        [
          {
            delta: {
              role: 'assistant',
              reasoning_content: 'x'.repeat(2 * 1024 * 1024 + 1),
            },
            finish_reason: null,
          },
          { delta: {}, finish_reason: 'stop' },
        ],
        answer('unexpected'),
      ]
    case 'arguments':
      return [
        call('read', { path: 'x'.repeat(2 * 1024 * 1024 + 1) }),
        answer('unexpected'),
      ]
    case 'batch':
      return [
        calls(
          Array.from({ length: 33 }, () => ({
            name: 'read',
            args: { path: '/fixture' },
          })),
        ),
        answer('unexpected'),
      ]
    case 'writes':
      return [
        ...Array.from({ length: 5 }, () =>
          call('write', { path: '/fixture', content: 'x'.repeat(256 * 1024) }),
        ),
        answer('unexpected'),
      ]
    case 'command':
      return [
        call('execute', { command: 'x'.repeat(16 * 1024 + 1) }),
        answer('unexpected'),
      ]
    case 'path':
      return [
        call('read', { path: 'x'.repeat(4 * 1024 + 1) }),
        answer('unexpected'),
      ]
    default:
      return [
        call('write', {
          path: '/fixture',
          content: 'é'.repeat(128 * 1024 + 1),
        }),
        answer('unexpected'),
      ]
  }
}

async function expectBudgetFailure(
  turn: Promise<unknown>,
  message = 'Pi turn budget exceeded',
) {
  const error = await turn.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toMatchObject({ message })
}

for (const scenario of [
  'iterations',
  'thinking',
  'arguments',
  'write',
] as const) {
  test(`native logical admission refuses ${scenario} without subsequent HTTP dispatch`, async () => {
    const responses = budgetResponses(scenario)
    const provider = fixture(responses)
    const assigned = sandbox()
    let writes = 0
    const write = assigned.tools.write
    assigned.tools.write = async (input) => {
      writes++
      await write(input)
    }
    try {
      const refusal = await createPiHarness({
        ...options,
        baseURL: provider.baseURL,
      })
        .turn({
          text: 'fixture',
          history: null,
          tools: assigned.tools,
          signal: AbortSignal.timeout(10000),
          onText() {},
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      expect(provider.requests).toHaveLength(scenario === 'iterations' ? 16 : 1)
      expect(refusal).toEqual(new Error('Pi turn budget exceeded'))
      expect(assigned.signals).toHaveLength(scenario === 'iterations' ? 16 : 0)
      expect(writes).toBe(0)
    } finally {
      await provider.close()
    }
  })
}

test('canonical history admission includes unselected metadata before HTTP dispatch', async () => {
  const manager = SessionManager.inMemory()
  manager.appendCustomEntry('private-fixture', {
    opaque: 'x'.repeat(4 * 1024 * 1024),
  })
  const history = {
    header: manager.getHeader(),
    entries: manager.getEntries(),
    leafID: manager.getLeafId(),
  }
  const provider = fixture([answer('unexpected')])
  try {
    await expectBudgetFailure(
      createPiHarness({ ...options, baseURL: provider.baseURL }).turn({
        text: 'fixture',
        history,
        tools: sandbox().tools,
        signal: AbortSignal.timeout(5000),
        onText() {},
      }),
      'Private history size limit exceeded',
    )
    expect(provider.requests).toHaveLength(0)
  } finally {
    await provider.close()
  }
})

test('imported model image admission refuses raw bytes before a subsequent HTTP dispatch', async () => {
  const provider = fixture([
    calls([
      {
        name: 'import_file',
        args: {
          assetID: '11111111-1111-4111-8111-111111111111',
          path: '/chosen',
        },
      },
    ]),
    answer('unexpected'),
  ])
  try {
    await expectBudgetFailure(
      createPiHarness({
        ...options,
        input: ['text', 'image'],
        baseURL: provider.baseURL,
      }).turn({
        text: 'fixture',
        history: null,
        fileTools: {
          assigned: [],
          prepared: [],
          hasUnknownOutcome: () => false,
          importFile: async () => ({
            bytes: new Uint8Array(1024 * 1024 + 1),
            mimeType: 'image/png',
          }),
          exportFile: async () => {
            throw new Error('Unexpected export')
          },
        },
        tools: sandbox().tools,
        signal: AbortSignal.timeout(5000),
        onText() {},
      }),
    )
    expect(provider.requests).toHaveLength(1)
  } finally {
    await provider.close()
  }
})

test('fatal tool admission aborts parallel siblings but joins an already started tool', async () => {
  const pending = pendingSandbox()
  const provider = fixture([
    calls([
      { name: 'execute', args: { command: 'pending' } },
      {
        name: 'write',
        args: { path: '/oversized', content: 'é'.repeat(128 * 1024 + 1) },
      },
      { name: 'write', args: { path: '/must-not-write', content: 'no' } },
    ]),
    answer('unexpected'),
  ])
  let returned = false
  const turn = createPiHarness({ ...options, baseURL: provider.baseURL }).turn({
    text: 'fixture',
    history: null,
    tools: pending.assigned.tools,
    signal: AbortSignal.timeout(5000),
    onText() {},
  })
  const outcome = turn.then(
    () => {
      returned = true
      return undefined
    },
    (error: unknown) => {
      returned = true
      return error
    },
  )
  try {
    await pending.started
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(pending.sawAbort).toBe(true)
    expect(returned).toBe(false)
    expect(pending.settled).toBe(false)
    expect(pending.assigned.files.size).toBe(0)
    pending.release()
    expect(await outcome).toEqual(new Error('Pi turn budget exceeded'))
    expect(pending.settled).toBe(true)
    expect(provider.requests).toHaveLength(1)
  } finally {
    pending.release()
    await outcome
    await provider.close()
  }
})

test('final canonical history admission refuses cumulative private tool output rather than trimming it', async () => {
  const provider = fixture([
    calls([{ name: 'read', args: { path: '/large' } }]),
    answer('exact final'),
  ])
  const assigned = sandbox()
  assigned.tools.read = async () => 'private'.repeat(700000)
  try {
    await expectBudgetFailure(
      createPiHarness({ ...options, baseURL: provider.baseURL }).turn({
        text: 'fixture',
        history: null,
        tools: assigned.tools,
        signal: AbortSignal.timeout(5000),
        onText() {},
      }),
      'Private history size limit exceeded',
    )
    expect(provider.requests).toHaveLength(2)
  } finally {
    await provider.close()
  }
})

test('native parameter limits reject a command without dispatching sandbox IO or aborting the turn', async () => {
  const provider = fixture([
    calls([{ name: 'execute', args: { command: 'x'.repeat(16 * 1024 + 1) } }]),
    answer('input rejected'),
  ])
  const assigned = sandbox()
  try {
    const result = await createPiHarness({
      ...options,
      baseURL: provider.baseURL,
    }).turn({
      text: 'fixture',
      history: null,
      tools: assigned.tools,
      signal: AbortSignal.timeout(5000),
      onText() {},
    })
    expect(result.text).toBe('input rejected')
    expect(assigned.commands).toHaveLength(0)
    expect(provider.requests).toHaveLength(2)
  } finally {
    await provider.close()
  }
})
