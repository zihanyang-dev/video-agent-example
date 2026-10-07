import { WEB_SOURCES_PER_TURN, type WebSource } from '@vid/contract/web-source'
import { InMemoryCredentialStore, Type, type AssistantMessageEvent } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent'
import type { AgentHarness, SandboxTools } from '../execution/contract.ts'
import { fileToolDefinitions } from './file-tools.ts'
import { webSearchTool, type WebSearchConfig } from './web-search.ts'
import { admitPiHistory, restorePiHistory } from './pi-history.ts'

export type PiHarnessOptions = Readonly<{
  baseURL: string
  key: string
  modelID: string
  contextWindow: number
  maxOutputTokens: number
  reasoning: boolean
  input: readonly ('text' | 'image')[]
  systemPrompt: string
  webSearch?: WebSearchConfig
}>

// Local logical admission and cleanup policy, not transport/RSS or remote settlement guarantees.
const maxTurnIterations = 16
const maxDecodedDeltaBytes = 2 * 1024 * 1024
const cancellationWaitMs = 10000

async function assignedModel(options: PiHarnessOptions) {
  // No file credential store, models.json, catalog network refresh or ambient discovery.
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  })
  const providerID = 'assigned-sandbox-model'
  runtime.registerProvider(providerID, {
    baseUrl: options.baseURL,
    api: 'openai-completions',
    authHeader: true,
    models: [
      {
        id: options.modelID,
        name: options.modelID,
        reasoning: options.reasoning,
        input: [...options.input],
        contextWindow: options.contextWindow,
        maxTokens: options.maxOutputTokens,
        // Endpoint pricing is not known to this harness; never invent billable estimates.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  })
  await runtime.setRuntimeApiKey(providerID, options.key)
  const model = runtime.getModel(providerID, options.modelID)
  if (!model) {
    throw new Error('Assigned Pi model unavailable')
  }
  return { runtime, model }
}

function isolatedResources(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  }
}

function executeTool(tools: SandboxTools, signal: AbortSignal) {
  return defineTool({
    name: 'execute',
    label: 'Execute',
    description: 'Execute a command in the assigned sandbox.',
    parameters: Type.Object({ command: Type.String({ maxLength: 16 * 1024 }) }),
    async execute(_id, params, sdkSignal) {
      const cancellation = sdkSignal === undefined ? signal : AbortSignal.any([signal, sdkSignal])
      cancellation.throwIfAborted()
      const result = await tools.execute({
        command: params.command,
        signal: cancellation,
      })
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: {},
      }
    },
  })
}

function readTool(tools: SandboxTools, signal: AbortSignal) {
  return defineTool({
    name: 'read',
    label: 'Read',
    description: 'Read a file in the assigned sandbox.',
    parameters: Type.Object({ path: Type.String({ maxLength: 4 * 1024 }) }),
    async execute(_id, params, sdkSignal) {
      const cancellation = sdkSignal === undefined ? signal : AbortSignal.any([signal, sdkSignal])
      cancellation.throwIfAborted()
      const content = await tools.read({
        path: params.path,
        signal: cancellation,
      })
      return { content: [{ type: 'text', text: content }], details: {} }
    },
  })
}

function writeTool(tools: SandboxTools, signal: AbortSignal, onLimit: () => never) {
  return defineTool({
    name: 'write',
    label: 'Write',
    description: 'Write a file in the assigned sandbox.',
    parameters: Type.Object({
      path: Type.String({ maxLength: 4 * 1024 }),
      content: Type.String({ maxLength: 256 * 1024 }),
    }),
    async execute(_id, params, sdkSignal) {
      const cancellation = sdkSignal === undefined ? signal : AbortSignal.any([signal, sdkSignal])
      cancellation.throwIfAborted()
      if (Buffer.byteLength(params.content) > 256 * 1024) onLimit()
      await tools.write({
        path: params.path,
        content: params.content,
        signal: cancellation,
      })
      return {
        content: [{ type: 'text', text: 'Written' }],
        details: {},
      }
    },
  })
}

type TurnInput = Parameters<AgentHarness['turn']>[0]

async function assignedSession(
  options: PiHarnessOptions,
  manager: SessionManager,
  { tools, signal, fileTools }: TurnInput,
  {
    onSources,
    onLimit,
  }: {
    onSources: (sources: readonly WebSource[]) => void
    onLimit: () => never
  },
) {
  const { runtime, model } = await assignedModel(options)
  const definitions = [
    executeTool(tools, signal),
    readTool(tools, signal),
    writeTool(tools, signal, onLimit),
    ...(options.webSearch === undefined
      ? []
      : [webSearchTool(options.webSearch, signal, onSources)]),
    ...(fileTools === undefined
      ? []
      : fileToolDefinitions(fileTools, signal, options.input.includes('image'), onLimit)),
  ]
  const { session } = await createAgentSession({
    modelRuntime: runtime,
    model,
    thinkingLevel: options.reasoning ? 'medium' : 'off',
    sessionManager: manager,
    resourceLoader: isolatedResources(options.systemPrompt),
    settingsManager: SettingsManager.inMemory({
      cacheWarming: 'off',
      compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0 } },
    }),
    // Name allowlist plus custom replacements: no host bash/edit/grep or skill tools.
    tools: definitions.map((definition) => definition.name),
    customTools: definitions,
  })
  return session
}

async function runTurn(
  options: PiHarnessOptions,
  manager: SessionManager,
  input: TurnInput,
  onSources: (sources: readonly WebSource[]) => void,
) {
  const { text: prompt, signal, onText, fileTools } = input
  // Byte bounds follow native parsing/retention, not transport frames or peak RSS.
  let budgetError: Error | undefined
  let aborting: Promise<void> | undefined
  let session: AgentSession
  const abort = () => {
    aborting ??= session.abort()
    void aborting.catch(() => {})
  }
  const refuse = () => {
    budgetError ??= new Error('Pi turn budget exceeded')
    abort()
  }
  const onLimit = (): never => {
    refuse()
    throw budgetError
  }
  session = await assignedSession(options, manager, input, {
    onSources,
    onLimit,
  })
  let iterations = 0
  let deltas = 0
  let failed = false
  const admitDelta = (delta: AssistantMessageEvent) => {
    if (
      delta.type !== 'text_delta' &&
      delta.type !== 'thinking_delta' &&
      delta.type !== 'toolcall_delta'
    )
      return
    const bytes = Buffer.byteLength(delta.delta)
    deltas += bytes
    if (deltas > maxDecodedDeltaBytes) refuse()
  }
  const unsubscribe = session.subscribe((event) => {
    // Subscribers are synchronous. Retain abort's idle receipt; never await it here.
    if (event.type === 'turn_start') {
      if (++iterations > maxTurnIterations) refuse()
      return
    }
    if (event.type === 'message_end') {
      if (event.message.role === 'assistant')
        failed ||= ['error', 'aborted'].includes(event.message.stopReason)
      return
    }
    if (event.type !== 'message_update') return
    admitDelta(event.assistantMessageEvent)
    if (!budgetError && event.assistantMessageEvent.type === 'text_delta')
      onText(event.assistantMessageEvent.delta)
  })
  signal.addEventListener('abort', abort, { once: true })
  let rejectPrompt: (() => void) | undefined
  try {
    // Abort may have arrived during asynchronous session construction.
    signal.throwIfAborted()
    let inputText = prompt
    if (fileTools !== undefined) {
      const assets = fileTools.assigned.map(({ assetID, name, mimeType }) => ({
        assetID,
        name,
        mimeType,
      }))
      inputText = `${prompt}
Assigned assets (import_file by assetID to a path you choose):
${JSON.stringify(assets)}`
    }
    const prompting = session.prompt(inputText).then(() => session.waitForIdle())
    void prompting.catch(() => {})
    await Promise.race([
      prompting,
      new Promise<never>((_, reject) => {
        rejectPrompt = () => reject(signal.reason)
        signal.addEventListener('abort', rejectPrompt, { once: true })
        if (signal.aborted) rejectPrompt()
      }),
    ])
    signal.throwIfAborted()
    if (budgetError) throw budgetError
    if (failed) {
      throw new Error('Pi model execution failed')
    }
    // Streaming may include tool-turn narration. The canonical answer is only
    // the final native assistant message; preserve its exact text, not the SDK
    // convenience getter's trimming. Thinking and tool blocks remain private.
    const answer = session.messages.findLast((message) => message.role === 'assistant')
    const history = {
      header: manager.getHeader(),
      entries: manager.getEntries(),
      leafID: manager.getLeafId(),
    }
    admitPiHistory(history)
    const finalText =
      answer?.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('') ?? ''
    return { text: finalText, history: structuredClone(history) }
  } finally {
    // prompt/abort settling owns tool lifetime; agent_end alone is not completion.
    signal.removeEventListener('abort', abort)
    if (rejectPrompt !== undefined) signal.removeEventListener('abort', rejectPrompt)
    // Abort is supported by Pi; bound our wait, without claiming the SDK joins
    // every remote operation. The rejected receipt remains supervised.
    const cleanup = aborting ?? session.abort()
    void cleanup.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        cleanup,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Pi cancellation deadline exceeded')),
            cancellationWaitMs,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
      unsubscribe()
      session.dispose()
    }
  }
}

export function createPiHarness(options: PiHarnessOptions): AgentHarness {
  return {
    async turn(input) {
      input.signal.throwIfAborted()
      // Fresh provenance for this assigned invocation, never restored from Pi
      // history or inferred from model text. Found does not mean read or cited.
      const sources: WebSource[] = []
      const urls = new Set<string>()
      const onSources = (found: readonly WebSource[]) => {
        for (const source of found) {
          if (sources.length === WEB_SOURCES_PER_TURN) break
          if (urls.has(source.url)) continue
          urls.add(source.url)
          sources.push(source)
        }
      }
      const manager = restorePiHistory(input.history)
      const result = await runTurn(options, manager, input, onSources)
      return { ...result, sources }
    },
  }
}
