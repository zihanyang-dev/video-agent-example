import { WEB_SOURCES_PER_TURN, type WebSource } from '@vid/contract/web-source'
import { InMemoryCredentialStore, type AssistantMessageEvent } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import {
  createAgentSession,
  createExtensionRuntime,
  loadSkills,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent'
import { NativeOwnerUnsettledError, type AgentHarness } from '../../contract.ts'
import { createToolDefinitions } from './tools.ts'
import type { WebSearchConfig } from '../web-search.ts'
import {
  bootstrapPiSession,
  checkpointPiSession,
  completedPiRequest,
  hasPiInput,
  openPiSession,
  readCompletedPiRequest,
  retainPiAssets,
} from './session'

type PiHarnessOptions = Readonly<{
  statePath: string
  baseURL: string
  key: string
  modelID: string
  contextWindow: number
  maxOutputTokens: number
  reasoning: boolean
  input: readonly ('text' | 'image')[]
  systemPrompt: string
  /** Trusted bundle deployed at the same absolute path in worker and sandbox. */
  skillsPath?: string
  webSearch?: WebSearchConfig
}>

// Local logical admission and cleanup policy, not transport/RSS or remote settlement guarantees.
const maxTurnIterations = 16
const maxDecodedDeltaBytes = 2 * 1024 * 1024
const cancellationWaitMs = 10000

async function assignedModel(
  options: PiHarnessOptions,
  manager: SessionManager,
  input: SessionInput,
) {
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
    streamSimple: (model, context, streamOptions) =>
      streamSimple({ ...model, api: 'openai-completions' }, context, {
        ...streamOptions,
        fetch: Object.assign(
          async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            // Both trusted export receipts and SDK tool results must be durable
            // before acknowledging effects or dispatching another model request.
            retainPiAssets(manager, input.runID, input.fileTools?.prepared)
            await checkpointPiSession(manager)
            await input.checkpoint()
            await input.beforeModel()
            input.signal.throwIfAborted()
            return await fetch(url, init)
          },
          { preconnect: fetch.preconnect },
        ),
      }),
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

function isolatedResources(systemPrompt: string, skillsPath?: string): ResourceLoader {
  const skills = loadSkills({
    cwd: '/',
    agentDir: '/',
    skillPaths: skillsPath === undefined ? [] : [skillsPath],
    includeDefaults: false,
  })
  if (skills.diagnostics.length > 0) throw new Error('Invalid assigned skill bundle')
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => skills,
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

type SessionInput = Parameters<AgentHarness['run']>[0]

async function assignedSession(
  options: PiHarnessOptions,
  manager: SessionManager,
  input: SessionInput,
  {
    onSources,
    onLimit,
  }: {
    onSources: (sources: readonly WebSource[]) => void
    onLimit: () => never
  },
) {
  const { runtime, model } = await assignedModel(options, manager, input)
  const definitions = createToolDefinitions({
    tools: input.tools,
    signal: input.signal,
    fileTools: input.fileTools,
    webSearch: options.webSearch,
    supportsImages: options.input.includes('image'),
    onSources,
    onLimit,
  })
  const { session } = await createAgentSession({
    modelRuntime: runtime,
    model,
    thinkingLevel: options.reasoning ? 'medium' : 'off',
    sessionManager: manager,
    resourceLoader: isolatedResources(options.systemPrompt, options.skillsPath),
    settingsManager: SettingsManager.inMemory({
      cacheWarming: 'off',
      compaction: {
        enabled: true,
        reserveTokens: Math.min(16384, Math.floor(options.contextWindow / 4)),
        keepRecentTokens: Math.min(20000, Math.floor(options.contextWindow / 2)),
      },
      retry: { enabled: false, provider: { maxRetries: 0 } },
    }),
    // No host filesystem tools; native skill commands use only the assigned bundle.
    tools: definitions.map((definition) => definition.name),
    customTools: definitions,
  })
  return session
}

/** Native event admission and public text observation, independent of session cleanup. */
function observeTurn(onText: SessionInput['onText']) {
  // Byte bounds follow native parsing/retention, not transport frames or peak RSS.
  const refusal = new AbortController()
  let iterations = 0
  let deltas = 0
  let failed = false
  const refuse = () => {
    if (!refusal.signal.aborted) refusal.abort(new Error('Pi turn budget exceeded'))
  }
  const admitDelta = (delta: AssistantMessageEvent) => {
    if (
      delta.type !== 'text_delta' &&
      delta.type !== 'thinking_delta' &&
      delta.type !== 'toolcall_delta'
    )
      return
    deltas += Buffer.byteLength(delta.delta)
    if (deltas > maxDecodedDeltaBytes) refuse()
  }
  const onEvent = (event: AgentSessionEvent) => {
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
    const delta = event.assistantMessageEvent
    admitDelta(delta)
    if (!refusal.signal.aborted && delta.type === 'text_delta') onText(delta.delta)
  }
  return {
    signal: refusal.signal,
    onEvent,
    onLimit: (): never => {
      refuse()
      throw refusal.signal.reason
    },
    assertSucceeded() {
      refusal.signal.throwIfAborted()
      if (failed) throw new Error('Pi model execution failed')
    },
  }
}

/** Only an owned abort/join receipt can classify Native ownership as unsettled. */
async function settleNativeOwner(cleanup: Promise<void>, prompting: Promise<void> | undefined) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all([
        cleanup,
        // Product/model rejection is settled, not an unknown Native join.
        prompting?.then(
          () => {},
          () => {},
        ),
      ]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Pi cancellation deadline exceeded')),
          cancellationWaitMs,
        )
      }),
    ])
  } catch (error) {
    // Never dispose or admit another invocation while the SDK may still write.
    throw new NativeOwnerUnsettledError(error)
  } finally {
    clearTimeout(timer)
  }
}

/** Owns the native writer receipts and synchronous abort subscription. */
class PiTurn {
  private aborting: Promise<void> | undefined
  private prompting: Promise<void> | undefined
  private rejectPrompt: (() => void) | undefined
  private readonly unsubscribe: () => void

  constructor(
    private readonly session: AgentSession,
    private readonly signal: AbortSignal,
    onEvent: (event: AgentSessionEvent) => void,
  ) {
    this.unsubscribe = session.subscribe(onEvent)
    signal.addEventListener('abort', this.abort, { once: true })
  }

  private readonly abort = () => {
    // Subscribers are synchronous; retain the idle receipt without awaiting it.
    if (this.aborting !== undefined) return
    try {
      this.aborting = this.session.abort()
    } catch (error) {
      this.aborting = Promise.reject(error)
    }
    void this.aborting.catch(() => {})
  }

  async prompt(manager: SessionManager, input: SessionInput) {
    this.signal.throwIfAborted()
    this.prompting = (
      hasPiInput(manager, input.runID)
        ? this.session.sendCustomMessage(
            {
              customType: 'platform-continuation',
              content:
                'Continue the existing task from its saved context. Inspect current state before repeating any action.',
              display: false,
              details: { runID: input.runID },
            },
            { triggerTurn: true },
          )
        : this.session.prompt(assignedPrompt(input))
    ).then(() => this.session.waitForIdle())
    void this.prompting.catch(() => {})
    await Promise.race([
      this.prompting,
      new Promise<never>((_, reject) => {
        this.rejectPrompt = () => reject(this.signal.reason)
        this.signal.addEventListener('abort', this.rejectPrompt, { once: true })
        if (this.signal.aborted) this.rejectPrompt()
      }),
    ])
    this.signal.throwIfAborted()
  }

  async close() {
    this.signal.removeEventListener('abort', this.abort)
    if (this.rejectPrompt !== undefined) this.signal.removeEventListener('abort', this.rejectPrompt)
    this.abort()
    try {
      await settleNativeOwner(this.aborting!, this.prompting)
    } finally {
      this.unsubscribe()
    }
    // A failed join must not dispose a session which may still write.
    this.session.dispose()
  }
}

function assignedPrompt(input: SessionInput) {
  if (input.fileTools === undefined) return input.text
  const assets = input.fileTools.assigned.map(({ assetID, name, mimeType }) => ({
    assetID,
    name,
    mimeType,
  }))
  return `${input.text}
Assigned assets (import_file by assetID to a path you choose):
${JSON.stringify(assets)}`
}

async function runSession(
  options: PiHarnessOptions,
  manager: SessionManager,
  input: SessionInput,
  onSources: (sources: readonly WebSource[]) => void,
) {
  const observation = observeTurn(input.onText)
  const signal = AbortSignal.any([input.signal, observation.signal])
  const session = await assignedSession(
    options,
    manager,
    { ...input, signal },
    {
      onSources,
      onLimit: observation.onLimit,
    },
  )
  const turn = new PiTurn(session, signal, observation.onEvent)
  try {
    await turn.prompt(manager, input)
    observation.assertSucceeded()
    // Only the last assistant message is canonical, without trimming or thinking blocks.
    const answer = session.messages.findLast((message) => message.role === 'assistant')
    const text =
      answer?.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('') ?? ''
    const assets = retainPiAssets(manager, input.runID, input.fileTools?.prepared)
    return {
      text,
      ...(input.fileTools === undefined && assets.length === 0 ? {} : { assets }),
    }
  } finally {
    await turn.close()
  }
}

export function createPiHarness(options: PiHarnessOptions): AgentHarness {
  return {
    async completed(identity) {
      if (identity.engine !== 'pi') throw new Error('Native harness engine mismatch')
      return readCompletedPiRequest(options.statePath, identity)
    },
    async run(input) {
      if (input.engine !== 'pi') throw new Error('Native harness engine mismatch')
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
      const manager = await openPiSession(
        options.statePath,
        input.threadID,
        input.nativeSessionID,
        {
          requireExisting: input.requireExisting,
          storage: input.nativeSessionStorage,
        },
      )
      const completed = completedPiRequest(manager, input.runID)
      if (completed !== undefined) return completed
      if (input.initialContext !== undefined) bootstrapPiSession(manager, input.initialContext)
      const result = { ...(await runSession(options, manager, input, onSources)), sources }
      manager.appendCustomEntry('platform-completed', { runID: input.runID, result })
      await checkpointPiSession(manager)
      await input.checkpoint()
      return result
    },
  }
}
