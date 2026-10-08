import { join } from 'node:path'
import {
  Agent,
  Runner,
  RunState,
  OpenAIResponsesModel,
  OpenAIResponsesCompactionSession,
  MemorySession,
  type OpenAIResponsesCompactionArgs,
  type Model,
  type ModelProvider,
  type ModelSettings,
} from '@openai/agents'
import OpenAI from 'openai'
import { z } from 'zod'
import {
  ASSET_MAX_OUTPUT_FILES,
  assetReferenceSchema,
  type AssetReference,
} from '@vid/contract/execution'
import { WEB_SOURCES_PER_TURN, webSourcesSchema, type WebSource } from '@vid/contract/web-source'
import {
  NativeOwnerUnsettledError,
  type AgentHarness,
  type ExecutionCompletion,
  type NativeRequestIdentity,
} from '../../contract.ts'
import type { WebSearchConfig } from '../web-search.ts'
import { FileSession, readJSON, writeJSON } from './session.ts'
import { createOpenAITools } from './tools.ts'

export type OpenAIHarnessOptions = Readonly<{
  statePath: string
  baseURL: string
  key: string
  modelID: string
  contextWindow: number
  maxOutputTokens: number
  reasoning: Exclude<NonNullable<ModelSettings['reasoning']>['effort'], undefined>
  input: readonly string[]
  systemPrompt: string
  webSearch?: WebSearchConfig
  /** Trusted controlled-model seam; never supplied by model input or environment. */
  model?: Model
  modelProvider?: ModelProvider
}>
type Snapshot = {
  nativeSessionID: string
  state: string
  sources: WebSource[]
  assets: AssetReference[]
  completion?: ExecutionCompletion
}
type SessionInput = Parameters<AgentHarness['run']>[0]

const snapshotSchema = z.strictObject({
  nativeSessionID: z.string(),
  state: z.string(),
  sources: webSourcesSchema,
  assets: z.array(assetReferenceSchema),
  completion: z
    .strictObject({
      text: z.string(),
      sources: webSourcesSchema.optional(),
      assets: z.array(assetReferenceSchema).max(ASSET_MAX_OUTPUT_FILES).optional(),
    })
    .optional(),
})

async function readSnapshot(path: string, nativeSessionID: string): Promise<Snapshot | undefined> {
  const value = await readJSON<unknown>(path)
  if (value === undefined) return undefined
  // Preserve identity-error priority without interpreting any SDK state.
  if (
    value !== null &&
    typeof value === 'object' &&
    'nativeSessionID' in value &&
    typeof value.nativeSessionID === 'string' &&
    value.nativeSessionID !== nativeSessionID
  )
    throw new Error('Native session identity mismatch')
  if (!snapshotSchema.safeParse(value).success) throw new Error('Invalid native run snapshot')
  // Validate only our envelope. Keep the original business facts and opaque SDK string.
  return value as Snapshot
}

function identity(value: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid native storage identity')
  return value
}

function snapshotWriter(path: string, input: SessionInput, prior: Snapshot | undefined) {
  const sources = [...(prior?.sources ?? [])]
  const assets = new Map((prior?.assets ?? []).map((asset) => [asset.assetID, asset]))
  let result: { state: { toString: () => string } }
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  let saves: Promise<void> = Promise.resolve()

  function save(completion?: ExecutionCompletion) {
    // Capture *inside* the serialized operation: concurrent tool callbacks cannot
    // overwrite a newer SDK state with a snapshot captured before an earlier save.
    saves = saves.then(async () => {
      await ready
      for (const asset of input.fileTools?.prepared ?? []) assets.set(asset.assetID, asset)
      await writeJSON(path, {
        nativeSessionID: input.nativeSessionID,
        state: result.state.toString(),
        sources: [...sources],
        assets: [...assets.values()],
        ...(completion === undefined ? {} : { completion }),
      } satisfies Snapshot)
    })
    return saves
  }

  return {
    save,
    sources,
    completion(text: string): ExecutionCompletion {
      for (const asset of input.fileTools?.prepared ?? []) assets.set(asset.assetID, asset)
      return { text, sources: [...sources], assets: [...assets.values()] }
    },

    attach(value: typeof result) {
      result = value
      release()
    },
  }
}

async function assignedModel(
  options: OpenAIHarnessOptions,
  input: SessionInput,
  checkpoint: () => Promise<void>,
) {
  // HTTP authorization lives at the actual client dispatch, including compact.
  // SDK hooks are observational and can swallow errors; they are not spend gates.
  const client = new OpenAI({
    apiKey: options.key,
    baseURL: options.baseURL,
    maxRetries: 0,
    fetch: async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      await checkpoint()
      await input.beforeModel()
      input.signal.throwIfAborted()
      return await fetch(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([input.signal, init.signal]) : input.signal,
      })
    },
  })
  const injected =
    options.model ??
    (options.modelProvider ? await options.modelProvider.getModel(options.modelID) : undefined)
  const native = injected ?? new OpenAIResponsesModel(client, options.modelID)
  let decodedBytes = 0
  const model: Model = {
    async getResponse(request) {
      if (injected) await checkpoint()
      if (injected) await input.beforeModel()
      input.signal.throwIfAborted()
      return await native.getResponse(request)
    },

    async *getStreamedResponse(request) {
      if (injected) await checkpoint()
      if (injected) await input.beforeModel()
      input.signal.throwIfAborted()
      for await (const event of native.getStreamedResponse(request)) {
        // Logical decoded-event admission, not HTTP/RSS or token accounting.
        decodedBytes += Buffer.byteLength(JSON.stringify(event))
        if (decodedBytes > 2 * 1024 * 1024) throw new Error('OpenAI event budget exceeded')
        yield event
      }
    },
  }
  return { client, model, injected }
}

function assignedAgent(
  options: OpenAIHarnessOptions,
  input: SessionInput,
  model: Model,
  writer: ReturnType<typeof snapshotWriter>,
) {
  const { save, sources } = writer
  return new Agent({
    name: 'video-agent',
    instructions:
      input.fileTools === undefined
        ? options.systemPrompt
        : `${options.systemPrompt}\nAssigned assets (import_file by assetID to a guest path you choose):\n${JSON.stringify(input.fileTools.assigned.map(({ assetID, name, mimeType }) => ({ assetID, name, mimeType })))}`,
    model,
    modelSettings: {
      store: false,
      maxTokens: options.maxOutputTokens,
      reasoning: { effort: options.reasoning },
      retry: { maxRetries: 0 },
      parallelToolCalls: false,
    },
    tools: createOpenAITools({
      tools: input.tools,
      signal: input.signal,
      fileTools: input.fileTools,
      webSearch: options.webSearch,
      supportsImages: options.input.includes('image'),
      beforeTool: save,
      onSources: (found) => {
        for (const source of found) {
          if (sources.length === WEB_SOURCES_PER_TURN) break
          if (!sources.some((existing) => existing.url === source.url)) sources.push(source)
        }
      },
    }),
  })
}

function sessionDirectory(statePath: string, input: NativeRequestIdentity) {
  const thread = join(statePath, 'openai', identity(input.threadID))
  return input.nativeSessionStorage === 'session'
    ? join(thread, identity(input.nativeSessionID))
    : thread
}

async function openRunSession(options: OpenAIHarnessOptions, input: SessionInput) {
  const directory = sessionDirectory(options.statePath, input)
  const snapshotPath = join(directory, 'runs', `${identity(input.runID)}.json`)
  const prior = await readSnapshot(snapshotPath, input.nativeSessionID)
  const fileSession = new FileSession(
    join(directory, 'session.json'),
    input.nativeSessionID,
    input.requireExisting || prior !== undefined,
  )
  await fileSession.getSessionId()
  return { fileSession, snapshotPath, prior }
}

function compactingSession(
  options: OpenAIHarnessOptions,
  client: OpenAI,
  fileSession: FileSession,
) {
  return Object.assign(fileSession, {
    async runCompaction(args?: OpenAIResponsesCompactionArgs) {
      const originalItems = await fileSession.getItems()
      // SDK clear/add happens only in a transient native buffer. The persistent
      // Session changes once, atomically, after official compaction succeeds.
      const buffer = new MemorySession({ initialItems: originalItems })
      const compaction = new OpenAIResponsesCompactionSession({
        client,
        model: options.modelID,
        underlyingSession: buffer,
        compactionMode: 'input',
        shouldTriggerCompaction: ({ sessionItems }) =>
          JSON.stringify(sessionItems).length >= options.contextWindow * 3,
      })
      const result = await compaction.runCompaction(args)
      if (result)
        await fileSession.replaceHistoryWithCompaction(await buffer.getItems(), originalItems)
      return result
    },
  })
}

/** Iterator cancellation requests abort but does not join the SDK's background writer. */
async function joinNativeRun(completed: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      // A model/tool rejection is a settled run, not an unknown physical owner.
      completed.then(
        () => {},
        () => {},
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new NativeOwnerUnsettledError(new Error('OpenAI cancellation deadline exceeded')),
            ),
          10000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** The public Runner owns generation, tools, history, compaction and recovery. */
export function createOpenAIHarness(options: OpenAIHarnessOptions): AgentHarness {
  return {
    async completed(input) {
      if (input.engine !== 'openai') throw new Error('Native harness engine mismatch')
      const directory = sessionDirectory(options.statePath, input)
      const path = join(directory, 'runs', `${identity(input.runID)}.json`)
      const snapshot = await readSnapshot(path, input.nativeSessionID)
      await new FileSession(
        join(directory, 'session.json'),
        input.nativeSessionID,
        input.requireExisting,
      ).getSessionId()
      return snapshot?.completion
    },

    async run(input) {
      if (input.engine !== 'openai') throw new Error('Native harness engine mismatch')
      input.signal.throwIfAborted()
      const { fileSession, snapshotPath, prior } = await openRunSession(options, input)
      if (prior?.completion) {
        await input.checkpoint()
        return prior.completion
      }
      if (input.initialContext !== undefined) await fileSession.bootstrap(input.initialContext)
      await fileSession.retainInput(input.runID, input.text, prior !== undefined)
      const writer = snapshotWriter(snapshotPath, input, prior)
      const { save } = writer

      async function modelBoundary() {
        input.signal.throwIfAborted()
        await fileSession.getSessionId()
        await save()
        await input.checkpoint()
        input.signal.throwIfAborted()
      }

      const { client, model, injected } = await assignedModel(options, input, modelBoundary)
      const agent = assignedAgent(options, input, model, writer)
      // Official native compaction only. No handwritten summary or truncation.
      const session = injected ? fileSession : compactingSession(options, client, fileSession)
      const start = prior ? await RunState.fromString(agent, prior.state) : []
      const runner = new Runner({ tracingDisabled: true })
      const streamed = await runner.run(agent, start, {
        stream: true,
        maxTurns: 16,
        session,
        signal: input.signal,
      })
      writer.attach(streamed)
      try {
        for await (const delta of streamed.toTextStream()) input.onText(delta)
      } finally {
        await joinNativeRun(streamed.completed)
      }
      await streamed.completed
      input.signal.throwIfAborted()
      // SDK completion also resolves on native cancellation, without a final output.
      // This is a joined failed result, not an unsettled physical writer.
      if (streamed.cancelled) throw new Error('OpenAI native run cancelled before completion')
      const finalOutput = streamed.finalOutput
      if (typeof finalOutput !== 'string')
        throw new Error('OpenAI native run ended without a string final output')
      // A best-effort SDK compaction hook must not hide a failed durable write.
      await fileSession.getItems()
      const completion = writer.completion(finalOutput)
      await save(completion)
      // Final ACK loss is safe: the durable terminal business result is returned
      // on re-entry without restoring/advancing a model or a tool.
      await input.checkpoint()
      return completion
    },
  }
}
