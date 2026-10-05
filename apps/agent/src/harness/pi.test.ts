import { expect, test } from 'bun:test'
import {
  parseSessionEntries,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { SandboxTools } from '../execute-run.ts'
import { restorePiHistory } from './pi-history.ts'
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
  let sawAbort = false
  let settled = false
  const assigned = sandbox()
  assigned.tools.execute = async ({ signal }) => {
    signal.addEventListener(
      'abort',
      () => {
        sawAbort = true
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
    release,
    get sawAbort() {
      return sawAbort
    },
    get settled() {
      return settled
    },
  }
}

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
      onText: () => {},
    })
    const outcome = turn.then(
      () => {
        returned = true
      },
      () => {
        returned = true
      },
    )
    await pending.started
    controller.abort()
    await Bun.sleep(25)
    expect(pending.sawAbort).toBe(true)
    expect(returned).toBe(false)
    pending.release()
    await outcome
    expect(pending.settled).toBe(true)
    expect(turn).rejects.toThrow()
    expect(provider.requests).toHaveLength(1)
  } finally {
    pending.release()
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
  test(`rejects nonempty history array ${JSON.stringify(history)} (bounded subprocess)`, async () => {
    const script = `
      import { restorePiHistory } from ${JSON.stringify(new URL('./pi-history.ts', import.meta.url).pathname)};
      try {
        restorePiHistory(${JSON.stringify(history)});
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
    expect(stdout.trim()).toBe('Invalid private Pi history')
    expect({ stderr, exitCode }).toEqual({ stderr: '', exitCode: 0 })
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
  const provider = fixture([answer('Seen'), answer('Again')])
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
    images: [{ bytes, mimeType: 'image/png' }],
  }
  try {
    const harness = createPiHarness({
      ...options,
      input: ['text', 'image'],
      baseURL: provider.baseURL,
    })
    const first = await harness.turn(input)
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain(
      `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
    )
    const { images: _images, ...continuation } = input
    await harness.turn({
      ...continuation,
      text: 'Continue',
      history: JSON.parse(JSON.stringify(first.history)),
    })
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
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
      images: [{ bytes: new Uint8Array([0, 255]), mimeType: 'image/png' }],
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
        args: { assetID: 'assigned', path: '/home/user/chosen-photo' },
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
            assetID: 'assigned',
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
