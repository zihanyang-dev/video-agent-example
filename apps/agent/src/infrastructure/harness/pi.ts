import {
  createAgentSession,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type FileEntry,
  type Skill,
} from '@earendil-works/pi-coding-agent'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import type { Sandbox } from '../../application/ports/sandbox'
import type {
  Harness,
  HarnessInput,
  ModelChoice,
  SkillIndex,
  StartHarness,
} from '../../application/ports/harness'
import { relayEvents } from './pi-events'
import { createAnnouncements } from './announcements'

export const startPiHarness: StartHarness = async (input): Promise<Harness> => {
  const modelRuntime = await configureModel(input.model)
  const model = modelRuntime.getModel(PROVIDER, input.model.id)
  if (!model) throw new Error(`model not resolved: ${input.model.id}`)

  const resourceLoader = await configureDiscovery(input)

  const { session } = await createAgentSession({
    cwd: input.sandbox.roots.host,
    agentDir: input.sandbox.roots.host,
    model,
    thinkingLevel: 'medium',
    modelRuntime,
    resourceLoader,
    // grep, find and ls are absent on purpose: their binaries run on the host rather than
    // in the sandbox, so they would search the wrong machine (architecture.md §8).
    tools: ['bash', 'read', 'write', 'edit'],
    sessionManager: SessionManager.inMemory(
      input.sandbox.roots.host,
      undefined,
      asSessionEntries(input.history),
    ),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    }),
  })

  verifyDelegation(session)
  const announcements = createAnnouncements()
  const stopRelay = relayEvents(session, input, announcements)

  return {
    run: async (message) => {
      await session.prompt(message)
      await session.agent.waitForIdle()
      requireModelReply(session)
    },
    flush: async () => {
      if (session.pendingMessageCount > 0) await session.agent.continue()
      await session.agent.waitForIdle()
      requireModelReply(session)
      for (const observation of announcements.settle()) input.onObservation(observation)
    },
    steer: (message) => session.steer(message),
    // Queued work goes too: messages waiting to be delivered to a session nobody is
    // waiting on any more would be applied to whatever ran next.
    interrupt: async () => {
      session.clearQueue()
      await session.abort()
    },
    entries: () => session.sessionManager.getEntries(),
    dispose: () => {
      stopRelay()
      session.dispose()
    },
  }
}

const PROVIDER = 'configured'

const configureModel = async (model: ModelChoice): Promise<ModelRuntime> => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  })
  runtime.registerProvider(PROVIDER, {
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
    api: 'openai-completions',
    authHeader: true,
    models: [
      {
        id: model.id,
        name: model.id,
        reasoning: true,
        input: ['text', 'image'],
        // Provider prices are not configured; SDK cost totals are placeholders, not charges.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
    ],
  })
  return runtime
}

// Disable host-file discovery: a workspace belongs to an untrusted conversation.
// Only compiled extension factories may execute code inside the agent process.
const configureDiscovery = async (input: HarnessInput): Promise<DefaultResourceLoader> => {
  const loader = new DefaultResourceLoader({
    cwd: input.sandbox.roots.host,
    agentDir: input.sandbox.roots.host,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: input.systemPrompt,
    extensionFactories: [sandboxTools(input.sandbox)],
    skillsOverride: () => ({ skills: input.skills.map(asSkill), diagnostics: [] }),
  })
  await loader.reload()
  return loader
}

const asSkill = (index: SkillIndex): Skill => ({
  name: index.name,
  description: index.description,
  filePath: `${index.dir}/SKILL.md`,
  baseDir: index.dir,
  sourceInfo: createSyntheticSourceInfo(`${index.dir}/SKILL.md`, { source: 'sdk' }),
  disableModelInvocation: false,
})

const sandboxTools =
  (sandbox: Sandbox) =>
  (pi: ExtensionAPI): void => {
    const root = sandbox.roots.host
    const read = {
      // pi's read tool wants a Buffer. The port deals in Uint8Array like every other
      // byte-carrying port here, so the Node-ism is put on here rather than pushed back
      // into an interface that has nothing to do with pi.
      readFile: async (path: string) => Buffer.from(await sandbox.readFile(path)),
      access: sandbox.access,
      detectImageMimeType: sandbox.mimeType,
    }
    // pi's write and edit tools deal in text; the sandbox deals in bytes, because carrying a
    // rendered clip back out is not a string.
    const write = {
      writeFile: (path: string, content: string) => sandbox.writeFile(path, Buffer.from(content)),
      mkdir: sandbox.mkdir,
    }

    pi.registerTool(
      createBashTool(root, {
        // Without this pi adds PI_* variables describing the model and session. The agent
        // has no reason to know either (architecture.md §8).
        exposeSessionEnvironment: false,
        operations: { exec: sandbox.exec },
      }),
    )
    pi.registerTool(createReadTool(root, { operations: read }))
    pi.registerTool(createWriteTool(root, { operations: write }))
    pi.registerTool(createEditTool(root, { operations: { ...read, ...write } }))
  }

const SANDBOX_TOOL_NAMES = ['bash', 'edit', 'read', 'write']
const INLINE_TOOL_SOURCE = 'inline'

// pi silently keeps built-in tools if an override stops matching. Validate their source
// before any prompt; otherwise a working bash tool could execute on the host.
const verifyDelegation = (session: AgentSession): void => {
  const active = [...session.getActiveToolNames()].sort()
  if (active.join(',') !== SANDBOX_TOOL_NAMES.join(',')) {
    throw new Error(
      `unexpected tool set: got [${active.join(', ')}], want [${SANDBOX_TOOL_NAMES.join(', ')}]`,
    )
  }

  const hostTools = session
    .getAllTools()
    .filter(
      (tool) =>
        SANDBOX_TOOL_NAMES.includes(tool.name) && tool.sourceInfo.source !== INLINE_TOOL_SOURCE,
    )
    .map((tool) => `${tool.name} (${tool.sourceInfo.source})`)

  if (hostTools.length > 0) {
    throw new Error(
      `these tools would run on the host, not in the sandbox: ${hostTools.join(', ')}`,
    )
  }
}

// These opaque entries were written by pi; only this adapter couples persisted history to its types.
const asSessionEntries = (history: readonly unknown[] | undefined): FileEntry[] | undefined =>
  history === undefined ? undefined : (history.slice() as FileEntry[])

// pi can resolve prompt() after storing a provider rejection as an assistant message.
// A resolved promise alone therefore cannot authorize a successful execution result.
const requireModelReply = (session: AgentSession): void => {
  const message = session.messages.at(-1)
  if (message?.role === 'assistant' && message.stopReason === 'error') {
    throw new Error(message.errorMessage ?? 'model request failed')
  }
}
