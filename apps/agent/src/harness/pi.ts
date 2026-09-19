/**
 * pi, wired to run against a sandbox.
 *
 * The only file allowed to name pi. What comes out is AG-UI; `message_update`,
 * `tool_execution_update` and every other name in pi's vocabulary stop here
 * (architecture.md §6).
 *
 * There are no custom tools. Every capability reaches the agent as a file or a command in
 * the sandbox, never as infrastructure it is forced to perceive (architecture.md §8).
 *
 * Assembly is verbose because almost all of it says one thing: do not read this machine's
 * disk. pi's defaults are built for one person at a terminal; we are a server where every
 * turn belongs to a different tenant.
 */
import { EventType, type Event } from '@ag-ui/core'
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
import { z } from 'zod'
import type { Sandbox } from '../sandbox/sandbox'
import type { Harness, HarnessInput, ModelChoice, SkillIndex, StartHarness } from './harness'

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
    // in the sandbox, so they would search the wrong machine (architecture.md §5).
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
  const unwatch = watch(session, input)

  return {
    run: (message) => runOnce(session, input, message),
    steer: (message) => session.steer(message),
    entries: () => session.sessionManager.getEntries(),
    cost: () => {
      const stats = session.getSessionStats()
      return { tokens: stats.tokens.total, usd: stats.cost }
    },
    dispose: () => {
      unwatch()
      session.dispose()
    },
  }
}

/**
 * AG-UI requires a run to be bracketed: RUN_STARTED, then exactly one of RUN_FINISHED or
 * RUN_ERROR. Emitted here rather than by the caller because this is where a run actually
 * begins and ends -- a steer arriving mid-run continues the same one.
 */
const runOnce = async (
  session: AgentSession,
  input: HarnessInput,
  message: string,
): Promise<void> => {
  input.onEvent({
    type: EventType.RUN_STARTED,
    threadId: input.threadID,
    runId: input.turnID,
  })

  try {
    await session.prompt(message)
    await session.agent.waitForIdle()
  } catch (error) {
    input.onEvent({
      type: EventType.RUN_ERROR,
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  }

  input.onEvent({ type: EventType.RUN_FINISHED, threadId: input.threadID, runId: input.turnID })
}

const PROVIDER = 'configured'

/**
 * One provider, configured at runtime, never read from disk. Credentials live in memory for
 * the length of one turn: a server has no "this machine's key", it has a key per tenant.
 *
 * Pricing is left at zero deliberately. Token counts are real and come from the provider;
 * what they cost is a billing question this process has no business answering.
 */
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
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
    ],
  })
  return runtime
}

/**
 * Every `no*` here turns off a discovery path that reads this machine. Skills arrive as
 * objects rather than files, so the index never touches a disk -- only the scripts do, and
 * those live in the sandbox (architecture.md §7).
 */
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

/**
 * pi's built-in tools with their execution backends replaced. This is the only supported way
 * in: `createAgentSession` does not expose the lower-level tool override, so a registered
 * tool of the same name is how a built-in gets replaced.
 */
const sandboxTools =
  (sandbox: Sandbox) =>
  (pi: ExtensionAPI): void => {
    const root = sandbox.roots.host
    const read = {
      readFile: sandbox.readFile,
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
        operations: { exec: (command, cwd, options) => sandbox.exec(command, cwd, options) },
      }),
    )
    pi.registerTool(createReadTool(root, { operations: read }))
    pi.registerTool(createWriteTool(root, { operations: write }))
    pi.registerTool(createEditTool(root, { operations: { ...read, ...write } }))
  }

const DELEGATED = ['bash', 'edit', 'read', 'write']
/** What pi labels a tool that came from an extension factory rather than its own registry. */
const OURS = 'inline'

/**
 * Proves, before the model is given anything to do, that the tools it holds reach the
 * sandbox.
 *
 * Replacing a built-in works by registering a tool of the same name -- verified: four
 * registrations, four replacements, no duplicates in the registry. The danger is that it is
 * *silent*. A renamed tool in a pi upgrade, or one typo here, and the agent keeps a working
 * `bash` that runs ffmpeg on this machine, with our environment, against our disk. Nothing
 * would throw; the sandbox would simply stop being involved.
 *
 * Each tool carries where it came from, and the two cases are distinguishable -- verified: a
 * replaced tool reports `inline`, one left alone reports `builtin`. That is the check.
 *
 * Structural rather than behavioural on purpose. Running a probe command would mean deciding
 * what a slow or broken container implies, and this question is not about the container's
 * health -- it is about which code the agent's tools point at.
 */
const verifyDelegation = (session: AgentSession): void => {
  const active = [...session.getActiveToolNames()].sort()
  if (active.join(',') !== DELEGATED.join(',')) {
    throw new Error(
      `unexpected tool set: got [${active.join(', ')}], want [${DELEGATED.join(', ')}]`,
    )
  }

  const onHost = session
    .getAllTools()
    .filter((tool) => DELEGATED.includes(tool.name) && tool.sourceInfo.source !== OURS)
    .map((tool) => `${tool.name} (${tool.sourceInfo.source})`)

  if (onHost.length > 0) {
    throw new Error(`these tools would run on the host, not in the sandbox: ${onHost.join(', ')}`)
  }
}

/**
 * pi carries no stable message id -- an assistant message has a model and a timestamp but no
 * identity -- so one is minted per turn. `contentIndex` separates spans within a message;
 * the counter separates messages within a turn.
 */
const watch = (session: AgentSession, input: HarnessInput): (() => void) => {
  let messageIndex = 0

  return session.subscribe((event) => {
    if (event.type === 'message_start') {
      messageIndex += 1
      return
    }
    if (event.type === 'message_update') {
      const id = `${input.turnID}:${messageIndex}`
      for (const translated of fromAssistant(event.assistantMessageEvent, id))
        input.onEvent(translated)
      return
    }
    if (event.type === 'tool_execution_update') {
      for (const announced of input.projection.fromOutput(textOf(event.partialResult))) {
        input.onEvent(announced)
      }
    }
    // Everything else produces nothing. Not a gap -- that is the rule (architecture.md §6).
  })
}

const fromAssistant = (event: AssistantEvent, id: string): readonly Event[] => {
  const messageId = 'contentIndex' in event ? `${id}:${event.contentIndex}` : id

  if (event.type === 'text_start') {
    return [{ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }]
  }
  if (event.type === 'text_delta') {
    return [{ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: strip(event.delta) }]
  }
  if (event.type === 'text_end') {
    return [{ type: EventType.TEXT_MESSAGE_END, messageId }]
  }
  return fromReasoning(event, messageId)
}

/**
 * Reasoning has its own channel, and that is the point: it must never arrive as message
 * text. It is shown while a turn runs and never stored -- the model's working notes are not
 * the conversation (architecture.md §3).
 */
const fromReasoning = (event: AssistantEvent, messageId: string): readonly Event[] => {
  if (event.type === 'thinking_start') {
    return [{ type: EventType.REASONING_MESSAGE_START, messageId, role: 'reasoning' }]
  }
  if (event.type === 'thinking_delta') {
    return [{ type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta: event.delta }]
  }
  if (event.type === 'thinking_end') {
    return [{ type: EventType.REASONING_MESSAGE_END, messageId }]
  }
  return []
}

/**
 * Some gateways inline reasoning into message text as a `<thinking>` block instead of
 * sending it on the reasoning channel. Observed once in three real runs against an
 * OpenAI-compatible endpoint. Rare is not good enough: a person seeing the model's private
 * working once is an incident, so it is removed here rather than hoped about.
 */
const strip = (delta: string): string => delta.replace(/<\/?thinking>/g, '')

/**
 * A tool's partial result is untyped on pi's side, so it is parsed rather than asserted --
 * this is a tool's JSON crossing into our code, which is exactly where §4.1 puts runtime
 * validation. Anything that does not match is simply not output a person could be shown.
 */
const ToolText = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
})

const textOf = (partial: unknown): string => {
  const parsed = ToolText.safeParse(partial)
  if (!parsed.success) return ''

  return parsed.data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/**
 * The port treats stored history as opaque, because its shape belongs to whichever harness
 * wrote it. This is the one place that knows the shape is pi's, so this is where it is said
 * -- and it is said with pi's own type rather than a cast that would accept anything.
 */
const asSessionEntries = (history: readonly unknown[] | undefined): FileEntry[] | undefined =>
  history === undefined ? undefined : (history.slice() as FileEntry[])

type AssistantEvent =
  Parameters<Parameters<AgentSession['subscribe']>[0]> extends [infer E]
    ? E extends { type: 'message_update'; assistantMessageEvent: infer A }
      ? A
      : never
    : never
