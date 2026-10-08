import { expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import type { SandboxTools } from '../../contract.ts'
import type { WebSearchConfig } from '../web-search'
import { createPiHarness } from './adapter.ts'

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

function fixture(responses: (Record<string, unknown>[] | Response)[]) {
  const statePath = mkdtempSync(join(tmpdir(), 'owned-pi-adapter-'))
  const threadID = crypto.randomUUID()
  const nativeSessionID = crypto.randomUUID()
  const requests: RequestBody[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe('Bearer fixture-only-key')
      requests.push((await request.json()) as RequestBody)
      const chunks = responses.shift()
      if (!chunks) return new Response('unexpected request', { status: 401 })
      if (chunks instanceof Response) return chunks
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
    statePath,
    threadID,
    nativeSessionID,
    nativeManager() {
      const file = SessionManager.findById('/', nativeSessionID, join(statePath, 'pi', threadID))
      if (!file) throw new Error('Expected persisted native Pi session')
      return SessionManager.open(file)
    },
    nativeJSONL() {
      const file = SessionManager.findById('/', nativeSessionID, join(statePath, 'pi', threadID))
      if (!file) throw new Error('Expected persisted native Pi session')
      return readFileSync(file, 'utf8')
    },
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    async close() {
      try {
        await server.stop(true)
      } finally {
        rmSync(statePath, { recursive: true, force: true })
      }
    },
  }
}

function identity(provider: ReturnType<typeof fixture>) {
  return {
    engine: 'pi' as const,
    threadID: provider.threadID,
    nativeSessionID: provider.nativeSessionID,
    runID: crypto.randomUUID(),
    async beforeModel() {},
    async checkpoint() {},
  }
}

function failure(run: Promise<unknown>) {
  return run.then(
    () => undefined,
    (error: unknown) => error,
  )
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
      statePath: provider.statePath,
      baseURL: provider.baseURL,
    }).run({
      text: 'Answer after checking notes',
      ...identity(provider),
      tools: sandbox().tools,
      signal: AbortSignal.timeout(5000),
      onText: (delta) => deltas.push(delta),
    })
    expect(result.text).toBe(final)
    expect(deltas.join('')).toBe('Checking the assigned notes. ' + final)
    expect(provider.nativeJSONL()).toContain('Checking the assigned notes.')
    expect(provider.nativeJSONL()).toContain('PRIVATE READ')
    expect(result.text).not.toContain('PRIVATE THINKING')
    expect(provider.requests).toHaveLength(2)
  } finally {
    await provider.close()
  }
})

test('fresh harnesses keep the same native session across multiple turns and request the assigned model', async () => {
  const provider = fixture([answer('Hello'), answer('Again')])
  const deltas: string[] = []
  try {
    const input = {
      ...identity(provider),
      text: 'first',
      tools: sandbox().tools,
      signal: AbortSignal.timeout(5000),
      onText: (text: string) => deltas.push(text),
    }
    const configuration = { ...options, statePath: provider.statePath, baseURL: provider.baseURL }
    const first = await createPiHarness(configuration).run(input)
    expect(first.text).toBe('Hello')
    expect(first).not.toHaveProperty('history')
    const file = provider.nativeManager().getSessionFile()
    const entries = provider.nativeManager().getEntries()
    const second = await createPiHarness(configuration).run({
      ...input,
      runID: crypto.randomUUID(),
      text: 'second',
    })
    expect(second.text).toBe('Again')
    const reopened = provider.nativeManager()
    expect(reopened.getSessionId()).toBe(provider.nativeSessionID)
    expect(reopened.getSessionFile()).toBe(file)
    expect(reopened.getEntries().slice(0, entries.length)).toEqual(entries)
    const request = provider.requests[1]!
    expect(JSON.stringify(request.messages)).toContain('first')
    expect(JSON.stringify(request.messages)).toContain('Hello')
    expect(JSON.stringify(request.messages)).toContain('second')
    expect(request.model).toBe('fixture-model')
    expect(provider.requests[0]!.max_tokens ?? provider.requests[0]!.max_completion_tokens).toBe(
      512,
    )
    expect(provider.requests[0]!.tools.map((tool) => tool.function.name).sort()).toEqual([
      'execute',
      'read',
      'write',
    ])
    expect(JSON.stringify(provider.requests[0]!.messages)).toContain(options.systemPrompt)
    expect(deltas.join('')).toBe('HelloAgain')
  } finally {
    await provider.close()
  }
})

test('same accepted run resumes persisted input and completed tools after pure model failure without duplicating the user', async () => {
  const provider = fixture([
    calls([{ name: 'execute', args: { command: 'render once' } }]),
    new Response('PRIVATE provider rejection', { status: 401 }),
    answer('Recovered'),
  ])
  const assigned = sandbox()
  const configuration = { ...options, statePath: provider.statePath, baseURL: provider.baseURL }
  const input = {
    ...identity(provider),
    text: 'ORIGINAL_TASK_CANARY',
    tools: assigned.tools,
    signal: AbortSignal.timeout(5000),
    onText() {},
  }
  try {
    expect(await failure(createPiHarness(configuration).run(input))).toEqual(
      new Error('Pi model execution failed'),
    )
    expect(assigned.commands).toEqual(['render once'])
    const messages = provider.nativeManager().buildSessionContext().messages
    expect(
      messages.some(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content).includes('ORIGINAL_TASK_CANARY'),
      ),
    ).toBe(true)
    expect(
      messages.some(
        (message) =>
          message.role === 'toolResult' &&
          JSON.stringify(message.content).includes('PRIVATE STDOUT'),
      ),
    ).toBe(true)
    const recovered = await createPiHarness(configuration).run(input)
    expect(recovered.text).toBe('Recovered')
    expect(provider.requests).toHaveLength(3)
    expect(JSON.stringify(provider.requests[2]!.messages)).toContain('PRIVATE STDOUT')
    const users = provider
      .nativeManager()
      .buildSessionContext()
      .messages.filter(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content).includes('ORIGINAL_TASK_CANARY'),
      )
    expect(users).toHaveLength(1)
    expect(assigned.commands).toEqual(['render once'])
  } finally {
    await provider.close()
  }
})

test('pure model failure retains the SDK input before any successful assistant exists', async () => {
  const provider = fixture([new Response('PRIVATE failure', { status: 401 }), answer('Next turn')])
  const configuration = { ...options, statePath: provider.statePath, baseURL: provider.baseURL }
  const input = {
    ...identity(provider),
    text: 'failed original input',
    tools: sandbox().tools,
    signal: AbortSignal.timeout(5000),
    onText() {},
  }
  try {
    expect(await failure(createPiHarness(configuration).run(input))).toEqual(
      new Error('Pi model execution failed'),
    )
    expect(provider.nativeJSONL()).toContain('failed original input')
    const next = await createPiHarness(configuration).run({
      ...input,
      runID: crypto.randomUUID(),
      text: 'continue',
    })
    expect(next.text).toBe('Next turn')
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain('failed original input')
    expect(provider.nativeManager().getSessionId()).toBe(provider.nativeSessionID)
  } finally {
    await provider.close()
  }
})

test('a current model failure cannot return a previous successful assistant', async () => {
  const provider = fixture([answer('Previous success'), new Response('failure', { status: 401 })])
  const configuration = { ...options, statePath: provider.statePath, baseURL: provider.baseURL }
  const input = {
    ...identity(provider),
    text: 'first',
    tools: sandbox().tools,
    signal: AbortSignal.timeout(5000),
    onText() {},
  }
  try {
    await createPiHarness(configuration).run(input)
    expect(
      await failure(
        createPiHarness(configuration).run({
          ...input,
          runID: crypto.randomUUID(),
          text: 'fail now',
        }),
      ),
    ).toEqual(new Error('Pi model execution failed'))
    expect(provider.requests).toHaveLength(2)
  } finally {
    await provider.close()
  }
})

test('durable final receipt survives acknowledgement loss without another model request or effect', async () => {
  const provider = fixture([
    calls([{ name: 'write', args: { path: '/receipt-output', content: 'once' } }]),
    answer('  Exact completed answer.\n'),
  ])
  const assigned = sandbox()
  let writes = 0
  const write = assigned.tools.write
  assigned.tools.write = async (input) => {
    writes++
    await write(input)
  }
  const configuration = { ...options, statePath: provider.statePath, baseURL: provider.baseURL }
  const input = {
    ...identity(provider),
    text: 'finish once',
    tools: assigned.tools,
    signal: AbortSignal.timeout(5000),
    onText() {},
    async checkpoint() {
      if (
        provider
          .nativeManager()
          .getBranch()
          .some((entry) => entry.type === 'custom' && entry.customType === 'platform-completed')
      )
        throw new Error('controlled receipt acknowledgement loss')
    },
  }
  try {
    expect(await failure(createPiHarness(configuration).run(input))).toEqual(
      new Error('controlled receipt acknowledgement loss'),
    )
    expect(writes).toBe(1)
    const recovered = await createPiHarness(configuration).run({
      ...input,
      tools: {
        async execute() {
          throw new Error('unexpected effect')
        },
        async write() {
          throw new Error('unexpected effect')
        },
        async read() {
          throw new Error('unexpected effect')
        },
      },
      async beforeModel() {
        throw new Error('unexpected model admission')
      },
      onText() {
        throw new Error('unexpected streaming')
      },
    })
    expect(recovered).toEqual({ text: '  Exact completed answer.\n', sources: [] })
    expect(provider.requests).toHaveLength(2)
    expect(writes).toBe(1)
  } finally {
    await provider.close()
  }
})

test('model authority refusal prevents HTTP dispatch after native input checkpoint', async () => {
  const provider = fixture([answer('must not run')])
  const refusal = new Error('model authority lost')
  const order: string[] = []
  try {
    expect(
      await failure(
        createPiHarness({
          ...options,
          statePath: provider.statePath,
          baseURL: provider.baseURL,
        }).run({
          ...identity(provider),
          text: 'accepted input',
          tools: sandbox().tools,
          signal: AbortSignal.timeout(5000),
          onText() {},
          async checkpoint() {
            expect(provider.nativeJSONL()).toContain('accepted input')
            order.push('checkpoint')
          },
          async beforeModel() {
            order.push('beforeModel')
            throw refusal
          },
        }),
      ),
    ).toBeInstanceOf(Error)
    expect(order).toEqual(['checkpoint', 'beforeModel'])
    expect(provider.requests).toHaveLength(0)
  } finally {
    await provider.close()
  }
})

test('official SDK compaction persists a summary in the assigned native session for the next harness turn', async () => {
  const provider = fixture([
    answer('Original answer'),
    answer('COMPACTED_TASK_SUMMARY'),
    answer('Continued'),
  ])
  const configuration = { ...options, statePath: provider.statePath, baseURL: provider.baseURL }
  const input = {
    ...identity(provider),
    text: 'Original task details',
    tools: sandbox().tools,
    signal: AbortSignal.timeout(5000),
    onText() {},
  }
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined
  try {
    await createPiHarness(configuration).run(input)
    const manager = provider.nativeManager()
    const priorEntries = manager.getEntries()
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    })
    runtime.registerProvider('owned-compaction', {
      baseUrl: provider.baseURL,
      api: 'openai-completions',
      authHeader: true,
      models: [
        {
          id: options.modelID,
          name: options.modelID,
          reasoning: false,
          input: ['text'],
          contextWindow: 16384,
          maxTokens: 512,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    })
    await runtime.setRuntimeApiKey('owned-compaction', options.key)
    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => options.systemPrompt,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources() {},
      async reload() {},
    }
    ;({ session } = await createAgentSession({
      sessionManager: manager,
      modelRuntime: runtime,
      model: runtime.getModel('owned-compaction', options.modelID)!,
      thinkingLevel: 'off',
      tools: [],
      resourceLoader,
      settingsManager: SettingsManager.inMemory({
        cacheWarming: 'off',
        compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 },
        retry: { enabled: false, provider: { maxRetries: 0 } },
      }),
    }))
    const compacted = await session.compact('Preserve the original task.')
    expect(compacted.summary).toContain('COMPACTED_TASK_SUMMARY')
    session.dispose()
    session = undefined
    const reopened = provider.nativeManager()
    expect(reopened.getSessionId()).toBe(provider.nativeSessionID)
    expect(reopened.getEntries().slice(0, priorEntries.length)).toEqual(priorEntries)
    expect(
      reopened
        .getBranch()
        .some(
          (entry) =>
            entry.type === 'compaction' && entry.summary.includes('COMPACTED_TASK_SUMMARY'),
        ),
    ).toBe(true)
    const continued = await createPiHarness(configuration).run({
      ...input,
      runID: crypto.randomUUID(),
      text: 'Continue after compaction',
    })
    expect(continued.text).toBe('Continued')
    expect(provider.requests).toHaveLength(3)
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain('Original task details')
    expect(JSON.stringify(provider.requests[2]!.messages)).toContain('COMPACTED_TASK_SUMMARY')
  } finally {
    session?.dispose()
    await provider.close()
  }
})

test('model shell and file requests cannot mutate or read corresponding host files', async () => {
  const provider = fixture([])
  const hostFile = join(provider.statePath, 'host-only.txt')
  const hostEffect = join(provider.statePath, 'must-not-exist.txt')
  writeFileSync(hostFile, 'HOST_SECRET_CANARY')
  const command = `printf host-effect > ${hostEffect}`
  // Use a second provider sharing no state with the host fixture; paths remain host-only.
  const model = fixture([
    calls([{ name: 'read', args: { path: hostFile } }]),
    calls([{ name: 'write', args: { path: hostFile, content: 'guest-only' } }]),
    calls([{ name: 'execute', args: { command } }]),
    answer('Isolated'),
  ])
  const assigned = sandbox()
  try {
    const result = await createPiHarness({
      ...options,
      statePath: model.statePath,
      baseURL: model.baseURL,
    }).run({
      ...identity(model),
      text: 'Operate in the assigned guest only',
      tools: assigned.tools,
      signal: AbortSignal.timeout(5000),
      onText() {},
    })
    expect(result.text).toBe('Isolated')
    expect(readFileSync(hostFile, 'utf8')).toBe('HOST_SECRET_CANARY')
    expect(existsSync(hostEffect)).toBe(false)
    expect(assigned.files.get(hostFile)).toBe('guest-only')
    expect(assigned.commands).toEqual([command])
    expect(JSON.stringify(model.requests)).not.toContain('HOST_SECRET_CANARY')
    expect(model.nativeJSONL()).not.toContain('HOST_SECRET_CANARY')
  } finally {
    await model.close()
    await provider.close()
  }
})

test('native skill discovery advertises metadata and loads full instructions through the assigned guest', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vid-skills-'))
  const skillPath = join(directory, 'render', 'SKILL.md')
  const referencePath = join(directory, 'render', 'references', 'formats.md')
  const scriptPath = join(directory, 'render', 'scripts', 'render.sh')
  let provider: ReturnType<typeof fixture> | undefined
  try {
    mkdirSync(join(directory, 'render', 'references'), { recursive: true })
    mkdirSync(join(directory, 'render', 'scripts'), { recursive: true })
    writeFileSync(
      skillPath,
      '---\nname: render\ndescription: Render a fixture clip\n---\nBODY_ONLY_AFTER_READ\nRead references/formats.md and run scripts/render.sh.\n',
    )
    writeFileSync(referencePath, 'REFERENCE_ONLY_AFTER_READ')
    writeFileSync(scriptPath, 'SCRIPT_ONLY_WHEN_EXECUTED')
    provider = fixture([
      calls([{ name: 'read', args: { path: skillPath } }]),
      calls([{ name: 'read', args: { path: referencePath } }]),
      calls([{ name: 'execute', args: { command: `sh ${scriptPath}` } }]),
      answer('Rendered'),
    ])
    const assigned = sandbox()
    assigned.files.set(
      skillPath,
      'GUEST_SKILL_BODY: Read references/formats.md and run scripts/render.sh.',
    )
    assigned.files.set(referencePath, 'GUEST_FORMAT_REFERENCE')
    const result = await createPiHarness({
      ...options,
      statePath: provider.statePath,
      baseURL: provider.baseURL,
      skillsPath: directory,
    }).run({
      text: 'Render a clip using the available skill',
      ...identity(provider),
      tools: assigned.tools,
      signal: AbortSignal.timeout(5000),
      onText: () => {},
    })
    const initial = JSON.stringify(provider.requests[0]!.messages)
    expect(initial).toContain('Render a fixture clip')
    expect(initial).toContain(skillPath)
    expect(initial).not.toContain('BODY_ONLY_AFTER_READ')
    expect(initial).not.toContain('GUEST_SKILL_BODY')
    expect(initial).not.toContain('REFERENCE_ONLY_AFTER_READ')
    expect(initial).not.toContain('SCRIPT_ONLY_WHEN_EXECUTED')
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain('GUEST_SKILL_BODY')
    expect(JSON.stringify(provider.requests[2]!.messages)).toContain('GUEST_FORMAT_REFERENCE')
    expect(assigned.commands).toEqual([`sh ${scriptPath}`])
    expect(result.text).toBe('Rendered')
  } finally {
    try {
      await provider?.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('an invalid configured skill bundle fails before inference without exposing its diagnostics', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vid-invalid-skills-'))
  const provider = fixture([answer('must not run')])
  try {
    mkdirSync(join(directory, 'broken'))
    writeFileSync(
      join(directory, 'broken', 'SKILL.md'),
      '---\nname: broken\n---\nPRIVATE_INVALID_BODY',
    )
    const failure = await createPiHarness({
      ...options,
      statePath: provider.statePath,
      baseURL: provider.baseURL,
      skillsPath: directory,
    })
      .run({
        text: 'do not infer',
        ...identity(provider),
        tools: sandbox().tools,
        signal: AbortSignal.timeout(5000),
        onText: () => {},
      })
      .catch((error: unknown) => error)
    expect(failure).toEqual(new Error('Invalid assigned skill bundle'))
    expect(provider.requests).toHaveLength(0)
  } finally {
    try {
      await provider.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('explicit skill commands use native expansion without exposing supporting files eagerly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vid-explicit-skills-'))
  const provider = fixture([answer('Selected')])
  try {
    mkdirSync(join(directory, 'render'))
    writeFileSync(
      join(directory, 'render', 'SKILL.md'),
      '---\nname: render\ndescription: Render a fixture clip\ndisable-model-invocation: true\n---\nEXPLICIT_INSTRUCTIONS\n',
    )
    const harness = createPiHarness({
      ...options,
      statePath: provider.statePath,
      baseURL: provider.baseURL,
      skillsPath: directory,
    })
    const input = {
      ...identity(provider),
      tools: sandbox().tools,
      signal: AbortSignal.timeout(5000),
      onText: () => {},
    }
    await harness.run({ ...input, text: '/skill:render chosen arguments' })
    const messages = JSON.stringify(provider.requests[0]!.messages)
    expect(messages).toContain('EXPLICIT_INSTRUCTIONS')
    expect(messages).toContain('chosen arguments')
    expect(messages).not.toContain('<available_skills>')
  } finally {
    try {
      await provider.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('host symlink errors cannot prevent a write to the assigned guest path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vid-guest-write-'))
  const guestPath = join(directory, 'loop', 'file.txt')
  let provider: ReturnType<typeof fixture> | undefined
  try {
    symlinkSync('loop', join(directory, 'loop'))
    provider = fixture([
      calls([{ name: 'write', args: { path: guestPath, content: 'guest bytes' } }]),
      answer('Done'),
    ])
    const assigned = sandbox()
    const result = await createPiHarness({
      ...options,
      statePath: provider.statePath,
      baseURL: provider.baseURL,
    }).run({
      text: 'Write in the assigned guest',
      ...identity(provider),
      tools: assigned.tools,
      signal: AbortSignal.timeout(5000),
      onText: () => {},
    })
    expect(result.text).toBe('Done')
    expect(assigned.files.get(guestPath)).toBe('guest bytes')
    expect(provider.nativeJSONL()).not.toContain('ELOOP')
  } finally {
    try {
      await provider?.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('executes only assigned sandbox tools with private results and meaningful side effects', async () => {
  const provider = fixture([
    calls([{ name: 'write', args: { path: '/work/video.txt', content: 'video' } }]),
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
      statePath: provider.statePath,
      baseURL: provider.baseURL,
    }).run({
      text: 'render',
      ...identity(provider),
      tools: assigned.tools,
      signal: new AbortController().signal,
      onText: (text) => deltas.push(text),
    })
    expect(assigned.files.get('/work/video.txt')).toBe('video')
    expect(assigned.commands).toEqual(['render video'])
    expect(assigned.signals).toHaveLength(3)
    expect(assigned.signals.every((signal) => signal instanceof AbortSignal)).toBe(true)
    expect(result.text).toBe('Rendered')
    expect(deltas.join('')).toBe('Rendered')
    expect(JSON.stringify(provider.requests[2]!.messages)).toContain('PRIVATE STDOUT')
    expect(provider.nativeJSONL()).toContain('PRIVATE STDOUT')
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
      createPiHarness({ ...options, statePath: provider.statePath, baseURL: provider.baseURL }).run(
        {
          text: 'no',
          ...identity(provider),
          tools: sandbox().tools,
          signal: controller.signal,
          onText: () => {},
        },
      ),
    ).rejects.toThrow()
    expect(provider.requests).toHaveLength(0)
  } finally {
    await provider.close()
  }
})

test('cancellation waits for the sandbox tool to settle before returning', async () => {
  const provider = fixture([calls([{ name: 'execute', args: { command: 'long render' } }])])
  const controller = new AbortController()
  const pending = pendingSandbox()
  const deltas: string[] = []
  let outcome: Promise<void> | undefined
  try {
    let returned = false
    const turn = createPiHarness({
      ...options,
      statePath: provider.statePath,
      baseURL: provider.baseURL,
    }).run({
      text: 'render',
      ...identity(provider),
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

test('combined assigned tools send only ordered public asset metadata and preserve canonical answer whitespace', async () => {
  const provider = fixture([answer(' \nExact 🎬 answer  \n')])
  try {
    const result = await createPiHarness({
      ...options,
      statePath: provider.statePath,
      baseURL: provider.baseURL,
      webSearch: {
        authMode: 'keyless',
        transport: async () => {
          throw new Error('Unexpected search dispatch')
        },
      },
    }).run({
      text: 'Inspect these assets in order.',
      ...identity(provider),
      tools: sandbox().tools,
      signal: AbortSignal.timeout(5000),
      onText: () => {},
      fileTools: {
        assigned: [
          {
            assetID: '11111111-1111-4111-8111-111111111111',
            objectKey: 'private-object-key-first',
            name: '电影 🎬.png',
            mimeType: 'image/png',
            byteLength: 3,
            sha256: 'a'.repeat(64),
          },
          {
            assetID: '22222222-2222-4222-8222-222222222222',
            objectKey: 'private-object-key-second',
            name: 'second.zip',
            mimeType: 'application/zip',
            byteLength: 5,
            sha256: 'b'.repeat(64),
          },
        ],
        prepared: [],
        importFile: async () => {
          throw new Error('Unexpected import')
        },
        exportFile: async () => {
          throw new Error('Unexpected export')
        },
      },
    })
    expect(result.text).toBe(' \nExact 🎬 answer  \n')
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]!.tools.map((tool) => tool.function.name).sort()).toEqual([
      'execute',
      'export_file',
      'import_file',
      'read',
      'web_search',
      'write',
    ])
    const expected =
      'Inspect these assets in order.\nAssigned assets (import_file by assetID to a path you choose):\n[{"assetID":"11111111-1111-4111-8111-111111111111","name":"电影 🎬.png","mimeType":"image/png"},{"assetID":"22222222-2222-4222-8222-222222222222","name":"second.zip","mimeType":"application/zip"}]'
    const messages = JSON.stringify(provider.requests[0]!.messages)
    expect(messages).toContain(JSON.stringify(expected))
    expect(messages).not.toContain('private-object-key')
    expect(messages).not.toContain('sha256')
    expect(messages).not.toContain('byteLength')
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
    ...identity(provider),
    tools: sandbox().tools,
    signal: AbortSignal.timeout(5000),
    onText: () => {},
    fileTools: {
      assigned: [],
      prepared: [],
      importFile: async () => ({ bytes, mimeType: 'image/png' }),
      exportFile: async () => {
        throw new Error('Unexpected export')
      },
    },
  }
  try {
    const harness = createPiHarness({
      ...options,
      statePath: provider.statePath,
      input: ['text', 'image'],
      baseURL: provider.baseURL,
    })
    await harness.run(input)
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
      `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
    )
    await harness.run({
      ...input,
      text: 'Continue',
      runID: crypto.randomUUID(),
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
    await createPiHarness({
      ...options,
      statePath: provider.statePath,
      baseURL: provider.baseURL,
    }).run({
      text: 'Inspect assigned file /home/user/materials/photo.png with tools',
      ...identity(provider),
      tools: sandbox().tools,
      signal: AbortSignal.timeout(5000),
      onText: () => {},
    })
    expect(JSON.stringify(provider.requests[0]?.messages)).not.toContain('image_url')
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
      statePath: provider.statePath,
      input: ['text', 'image'],
      baseURL: provider.baseURL,
    }).run({
      text: 'Import the assigned photo',
      ...identity(provider),
      tools: sandbox().tools,
      signal: AbortSignal.timeout(5000),
      onText: () => {},
      fileTools: {
        assigned: [],
        prepared: [],
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
        statePath: provider.statePath,
        input,
        baseURL: provider.baseURL,
      }).run({
        text: 'Import',
        ...identity(provider),
        tools: sandbox().tools,
        signal: AbortSignal.timeout(5000),
        onText: () => {},
        fileTools: {
          assigned: [],
          prepared: [],
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
      expect(JSON.stringify(provider.requests[1]?.messages)).not.toContain('image_url')
      expect(JSON.stringify(provider.requests[1]?.messages)).toContain('Use tools to inspect')
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
    ...identity(provider),
    tools: sandbox().tools,
    signal: AbortSignal.timeout(5000),
    onText: (_text: string) => {},
  }
  try {
    const first = await createPiHarness({
      ...options,
      statePath: provider.statePath,
      baseURL: provider.baseURL,
      webSearch,
    }).run(input)
    expect(first.text).toBe('Source: https://example.org/source')
    expect(first.sources).toEqual([{ title: 'Public source', url: 'https://example.org/source' }])
    expect(JSON.stringify(first.sources)).not.toContain('Quoted evidence')
    expect(provider.requests[0]!.tools.map((tool) => tool.function.name).sort()).toEqual([
      'execute',
      'read',
      'web_search',
      'write',
    ])
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain('Quoted evidence')
    expect(provider.nativeJSONL()).toContain('web_search')
    const second = await createPiHarness({
      ...options,
      statePath: provider.statePath,
      baseURL: provider.baseURL,
      webSearch,
    }).run({
      ...input,
      text: 'continue',
      runID: crypto.randomUUID(),
    })
    expect(JSON.stringify(provider.requests[2]!.messages)).toContain('Quoted evidence')
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
      statePath: provider.statePath,
      baseURL: provider.baseURL,
      webSearch: {
        authMode: 'keyless',
        transport: (async () => {
          searches++
          return Response.json({ results: [] })
        }) as NonNullable<WebSearchConfig['transport']>,
      },
    }).run({
      text: 'search',
      ...identity(provider),
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
      statePath: provider.statePath,
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
    }).run({
      text: 'research',
      ...identity(provider),
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
      statePath: provider.statePath,
      baseURL: provider.baseURL,
      webSearch: {
        authMode: 'key',
        apiKey: 'fixture-search-key',
        transport: (async () => {
          searches++
          throw new Error('PRIVATE provider body fixture-search-key')
        }) as NonNullable<WebSearchConfig['transport']>,
      },
    }).run({
      text: 'research',
      ...identity(provider),
      tools: assigned.tools,
      signal: AbortSignal.timeout(5000),
      onText: (text) => deltas.push(text),
    })
    expect(result.text).toBe('Search unavailable')
    expect(deltas.join('')).toBe('Search unavailable')
    expect(assigned.commands).toEqual([])
    expect(searches).toBe(1)
    const replay = provider.nativeJSONL()
    expect(replay).toContain('Web search unavailable.')
    expect(replay).not.toContain('fixture-search-key')
    expect(replay).not.toContain('PRIVATE provider body')
    expect(JSON.stringify(provider.requests[1]!.messages)).not.toContain('PRIVATE provider body')
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
    statePath: provider.statePath,
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
    ...identity(provider),
    tools: sandbox().tools,
    signal: AbortSignal.timeout(5000),
    onText: () => {},
  }
  try {
    await harness.run(input)
    expect(searches).toBe(3)
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain(
      'Search limit reached for this turn.',
    )
    await harness.run({
      ...input,
      text: 'new turn',
      runID: crypto.randomUUID(),
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
      statePath: provider.statePath,
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
    }).run({
      text: 'research',
      ...identity(provider),
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
      statePath: provider.statePath,
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
    }).run({
      text: 'research',
      ...identity(provider),
      tools: sandbox().tools,
      signal: AbortSignal.timeout(5000),
      onText: () => {},
    })
    expect(result.sources).toEqual([{ title: 'Found', url: 'https://example.org/' }])
  } finally {
    await provider.close()
  }
})

type BudgetScenario = 'iterations' | 'text' | 'thinking' | 'arguments' | 'write'

function budgetResponses(scenario: BudgetScenario) {
  const call = (name: string, args: unknown) => calls([{ name, args }])
  switch (scenario) {
    case 'iterations':
      return [
        ...Array.from({ length: 17 }, () => call('read', { path: '/fixture' })),
        answer('unexpected'),
      ]
    case 'text':
      return [answer('x'.repeat(2 * 1024 * 1024 + 1)), answer('unexpected')]
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
      return [call('read', { path: 'x'.repeat(2 * 1024 * 1024 + 1) }), answer('unexpected')]
    case 'write':
      return [
        call('write', {
          path: '/fixture',
          content: 'é'.repeat(128 * 1024 + 1),
        }),
        answer('unexpected'),
      ]
  }
}

async function expectBudgetFailure(turn: Promise<unknown>, message = 'Pi turn budget exceeded') {
  const error = await turn.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toMatchObject({ message })
}

for (const scenario of ['iterations', 'text', 'thinking', 'arguments', 'write'] as const) {
  test(`native logical admission refuses ${scenario} without subsequent HTTP dispatch`, async () => {
    const responses = budgetResponses(scenario)
    const provider = fixture(responses)
    const assigned = sandbox()
    const deltas: string[] = []
    let writes = 0
    const write = assigned.tools.write
    assigned.tools.write = async (input) => {
      writes++
      await write(input)
    }
    try {
      const refusal = await createPiHarness({
        ...options,
        statePath: provider.statePath,
        baseURL: provider.baseURL,
      })
        .run({
          text: 'fixture',
          ...identity(provider),
          tools: assigned.tools,
          signal: AbortSignal.timeout(10000),
          onText(delta) {
            deltas.push(delta)
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      expect(provider.requests).toHaveLength(scenario === 'iterations' ? 16 : 1)
      expect(refusal).toEqual(new Error('Pi turn budget exceeded'))
      expect(assigned.signals).toHaveLength(scenario === 'iterations' ? 16 : 0)
      expect(writes).toBe(0)
      expect(deltas).toEqual([])
    } finally {
      await provider.close()
    }
  })
}

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
        statePath: provider.statePath,
        input: ['text', 'image'],
        baseURL: provider.baseURL,
      }).run({
        text: 'fixture',
        ...identity(provider),
        fileTools: {
          assigned: [],
          prepared: [],
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
  const turn = createPiHarness({
    ...options,
    statePath: provider.statePath,
    baseURL: provider.baseURL,
  }).run({
    text: 'fixture',
    ...identity(provider),
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

test('native parameter limits reject a command without dispatching sandbox IO or aborting the turn', async () => {
  const provider = fixture([
    calls([{ name: 'execute', args: { command: 'x'.repeat(16 * 1024 + 1) } }]),
    answer('input rejected'),
  ])
  const assigned = sandbox()
  try {
    const result = await createPiHarness({
      ...options,
      statePath: provider.statePath,
      baseURL: provider.baseURL,
    }).run({
      text: 'fixture',
      ...identity(provider),
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
