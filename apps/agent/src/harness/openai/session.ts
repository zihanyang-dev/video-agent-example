import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import {
  conversationContextSchema,
  type ConversationContext,
} from '@vid/contract/conversation-context'
import type { AgentInputItem, Session } from '@openai/agents'
import { z } from 'zod'
import { NativeStateLostError } from '../../contract'

/** Atomically write JSON and sync the file and its containing directory. */
export async function writeJSON(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(value))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch (error) {
    // Remove only this uncommitted temporary; rename may already have committed.
    // Never roll back or delete the target after an unknown ACK.
    try {
      await rm(temporary, { force: true })
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'JSON write and temporary cleanup failed')
    }
    throw error
  }
}

/** Only a missing file is absence; callers validate their own JSON envelopes. */
export async function readJSON<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

type SessionStore = {
  sessionID: string
  items: AgentInputItem[]
  // Private business-run deduplication metadata, never provider message IDs.
  admittedRuns?: string[]
  bootstrapDigest?: string
}

const bootstrapDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .optional()

function historicalText(message: ConversationContext['turns'][number]['output']) {
  const lines = ['Completed conversation history (reference only):', message.text]
  if (message.assets !== undefined)
    lines.push(
      'Historical assets:',
      JSON.stringify(message.assets.map(({ name, mimeType }) => ({ name, mimeType }))),
    )
  if (message.sources !== undefined)
    lines.push('Historical sources:', JSON.stringify(message.sources))
  return lines.join('\n')
}

/** Basic public Session only: SDK items are stored verbatim, never translated. */
export class FileSession implements Session {
  // A failed mutation stays on this instance: later SDK reads/writes must not
  // conceal an unknown durable outcome by continuing on the same session.
  private pending: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly sessionID: string,
    private requireExisting = false,
  ) {}

  async getSessionId() {
    await this.pending
    await this.load()
    return this.sessionID
  }

  private async load() {
    const store = await readJSON<SessionStore>(this.path)
    if (store === undefined) {
      if (this.requireExisting) throw new NativeStateLostError()
      return { sessionID: this.sessionID, items: [] } satisfies SessionStore
    }

    // Validate our storage envelope, not a replica of the SDK's item schema.
    // A present but malformed file is never an empty-history initialization.
    if (!Array.isArray(store?.items)) throw new Error('Invalid native session history')
    if (store.sessionID !== this.sessionID) throw new Error('Native session identity mismatch')
    if (
      store.admittedRuns !== undefined &&
      (!Array.isArray(store.admittedRuns) ||
        store.admittedRuns.some((id) => typeof id !== 'string'))
    )
      throw new Error('Invalid native input admission metadata')
    if (!bootstrapDigestSchema.safeParse(store.bootstrapDigest).success)
      throw new Error('Invalid native context bootstrap metadata')
    this.requireExisting = true
    return store
  }

  async getItems(limit?: number) {
    await this.pending
    const { items } = await this.load()
    return limit === undefined ? items : limit <= 0 ? [] : items.slice(-limit)
  }

  private mutate<T>(operation: (store: SessionStore) => T): Promise<T> {
    const next = this.pending.then(async () => {
      const store = await this.load()
      const result = operation(store)
      await writeJSON(this.path, store)
      this.requireExisting = true
      return result
    })
    this.pending = next
    return next
  }

  async bootstrap(context: ConversationContext) {
    const parsed = conversationContextSchema.parse(context)
    const digest = createHash('sha256').update(JSON.stringify(parsed)).digest('hex')
    await this.mutate((store) => {
      if (store.bootstrapDigest !== undefined) {
        if (store.bootstrapDigest !== digest) throw new Error('Native context bootstrap conflict')
        return
      }
      if (this.requireExisting || store.items.length > 0 || (store.admittedRuns?.length ?? 0) > 0)
        throw new Error('Existing native history cannot accept initial context')
      // Public roles describe completed business facts, not invented provider responses.
      // History and its initialization digest commit together with no tool-call items.
      for (const { input, output } of parsed.turns) {
        store.items.push(
          { type: 'message', role: 'user', content: historicalText(input) },
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: historicalText(output) }],
          },
        )
      }
      store.bootstrapDigest = digest
    })
  }

  async retainInput(runID: string, text: string, requireAdmitted = false) {
    await this.mutate((store) => {
      const legacy = store.items.some(
        (item) =>
          item.type === 'message' &&
          item.role === 'user' &&
          typeof item.id === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id),
      )
      if (legacy) throw new Error('Legacy business input IDs require explicit offline migration')
      if (store.admittedRuns?.includes(runID)) return
      if (requireAdmitted)
        throw new Error('Missing native input admission; explicit recovery required')
      // mutate saves the input and its admission marker together in one atomic write.
      store.items.push({ type: 'message', role: 'user', content: text })
      store.admittedRuns = [...(store.admittedRuns ?? []), runID]
    })
  }

  async addItems(items: AgentInputItem[]) {
    await this.mutate((stored) => {
      stored.items.push(...items)
    })
  }

  async popItem() {
    return await this.mutate((store) => store.items.pop())
  }

  async clearSession() {
    await this.mutate((store) => {
      store.items.length = 0
      store.admittedRuns = []
    })
  }

  async replaceHistoryWithCompaction(items: AgentInputItem[], expected?: AgentInputItem[]) {
    await this.mutate((stored) => {
      // Compare against the history compacted by the SDK before replacing it;
      // keep concurrent additions on mismatch and preserve admittedRuns on success.
      if (expected !== undefined && JSON.stringify(stored.items) !== JSON.stringify(expected))
        throw new Error('Native session changed during compaction; history retained')
      stored.items.splice(0, stored.items.length, ...items)
    })
  }
}
