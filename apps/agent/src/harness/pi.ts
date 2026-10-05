import {
  InMemoryCredentialStore,
  Type,
  type ImageContent,
} from '@earendil-works/pi-ai'
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
import type { AgentHarness, SandboxTools } from '../execute-run.ts'
import { fileToolDefinitions } from './file-tools'
import { restorePiHistory } from './pi-history.ts'

export type PiHarnessOptions = Readonly<{
  baseURL: string
  key: string
  modelID: string
  contextWindow: number
  maxOutputTokens: number
  reasoning: boolean
  input: readonly ('text' | 'image')[]
  systemPrompt: string
}>

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
    parameters: Type.Object({ command: Type.String() }),
    async execute(_id, params, sdkSignal) {
      const result = await tools.execute({
        command: params.command,
        signal: sdkSignal ?? signal,
      })
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: result,
      }
    },
  })
}

function readTool(tools: SandboxTools, signal: AbortSignal) {
  return defineTool({
    name: 'read',
    label: 'Read',
    description: 'Read a file in the assigned sandbox.',
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, params, sdkSignal) {
      const content = await tools.read({
        path: params.path,
        signal: sdkSignal ?? signal,
      })
      return { content: [{ type: 'text', text: content }], details: {} }
    },
  })
}

function writeTool(tools: SandboxTools, signal: AbortSignal) {
  return defineTool({
    name: 'write',
    label: 'Write',
    description: 'Write a file in the assigned sandbox.',
    parameters: Type.Object({
      path: Type.String(),
      content: Type.String(),
    }),
    async execute(_id, params, sdkSignal) {
      await tools.write({
        path: params.path,
        content: params.content,
        signal: sdkSignal ?? signal,
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
) {
  const { runtime, model } = await assignedModel(options)
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
    tools: [
      'execute',
      'read',
      'write',
      ...(fileTools === undefined ? [] : ['import_file', 'export_file']),
    ],
    customTools: [
      executeTool(tools, signal),
      readTool(tools, signal),
      writeTool(tools, signal),
      ...(fileTools === undefined
        ? []
        : fileToolDefinitions(
            fileTools,
            signal,
            options.input.includes('image'),
          )),
    ],
  })
  return session
}

function encodePromptImages(
  images: NonNullable<TurnInput['images']>,
): ImageContent[] {
  return images.map((image) => ({
    type: 'image',
    data: Buffer.from(image.bytes).toString('base64'),
    mimeType: image.mimeType,
  }))
}

async function runTurn(
  session: AgentSession,
  manager: SessionManager,
  { text: prompt, signal, onText, images, fileTools }: TurnInput,
) {
  let text = ''
  let failed = false
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      failed ||=
        event.message.stopReason === 'error' ||
        event.message.stopReason === 'aborted'
    }
    if (
      event.type === 'message_update' &&
      event.assistantMessageEvent.type === 'text_delta'
    ) {
      const delta = event.assistantMessageEvent.delta
      text += delta
      onText(delta)
    }
  })
  let aborting: Promise<void> | undefined
  const abort = () => {
    aborting ??= session.abort()
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    // Abort may have arrived during asynchronous session construction.
    signal.throwIfAborted()
    const inputText =
      fileTools === undefined
        ? prompt
        : `${prompt}
Assigned assets (import_file by assetID to a path you choose):
${JSON.stringify(fileTools.assigned.map(({ assetID, name, mimeType }) => ({ assetID, name, mimeType })))}`
    await session.prompt(
      inputText,
      images === undefined ? undefined : { images: encodePromptImages(images) },
    )
    await session.waitForIdle()
    signal.throwIfAborted()
    if (failed) {
      throw new Error('Pi model execution failed')
    }
    return {
      text,
      history: structuredClone({
        header: manager.getHeader(),
        entries: manager.getEntries(),
        leafID: manager.getLeafId(),
      }),
    }
  } finally {
    // prompt/abort settling owns tool lifetime; agent_end alone is not completion.
    signal.removeEventListener('abort', abort)
    // In the pinned SDK abort uses native controllers and an idle waiter that
    // only resolves. No extensions, retry, compaction or warming hooks are enabled
    // here; do not invent a second cancellation timeout that detaches real tools.
    await (aborting ?? session.abort())
    unsubscribe()
    session.dispose()
  }
}

export function createPiHarness(options: PiHarnessOptions): AgentHarness {
  return {
    async turn(input) {
      input.signal.throwIfAborted()
      const manager = restorePiHistory(input.history)
      const session = await assignedSession(options, manager, input)
      // Text-only assignments receive file paths, never a pretend image modality.
      if (options.input.includes('image'))
        return await runTurn(session, manager, input)
      const { images: _images, ...textInput } = input
      return await runTurn(session, manager, textInput)
    },
  }
}
