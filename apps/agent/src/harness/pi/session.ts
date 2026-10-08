import { mkdir, open, readFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  conversationContextSchema,
  type ConversationContext,
} from '@vid/contract/conversation-context'
import { z } from 'zod'
import {
  SessionManager,
  type FileEntry,
  migrateSessionEntries,
  parseSessionEntries,
} from '@earendil-works/pi-coding-agent'
import { assetReferenceSchema, type AssetReference } from '@vid/contract/execution'
import { webSourcesSchema } from '@vid/contract/web-source'
import {
  NativeStateLostError,
  type ExecutionCompletion,
  type NativeRequestIdentity,
} from '../../contract'

const inputAdmissionSchema = z.strictObject({ runID: z.uuid() })

const assetReceiptSchema = z.strictObject({
  runID: z.uuid(),
  asset: assetReferenceSchema,
})

const completionSchema = z.strictObject({
  runID: z.uuid(),
  result: z.strictObject({
    text: z.string(),
    sources: webSourcesSchema.optional(),
    assets: z.array(assetReferenceSchema).optional(),
  }),
})

const entryTypeSchema = z.array(z.object({ type: z.string() }))
const sessionVersionSchema = z.object({ version: z.number().int().positive().optional() })
const lineageSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
})

/** Complete one parent path, sharing completed ancestors with subsequent walks. */
function completePiLineage(
  id: string,
  parents: ReadonlyMap<string, string | null>,
  complete: Set<string>,
) {
  const path = new Set<string>()
  let current: string | null = id
  while (current !== null && !complete.has(current)) {
    const parent = parents.get(current)
    if (parent === undefined || path.has(current)) throw new Error('Invalid native Pi session')
    path.add(current)
    current = parent
  }
  for (const visited of path) complete.add(visited)
}

function assertPiLineage(entries: readonly FileEntry[]) {
  const parents = new Map<string, string | null>()
  for (const entry of entries.slice(1)) {
    const lineage = lineageSchema.safeParse(entry)
    if (!lineage.success || parents.has(lineage.data.id))
      throw new Error('Invalid native Pi session')
    parents.set(lineage.data.id, lineage.data.parentId)
  }
  // Check every branch, not just the current leaf. Each edge is visited once,
  // with no recursive stack growth.
  const complete = new Set<string>()
  for (const id of parents.keys()) completePiLineage(id, parents, complete)
}

/** SDK parsing skips malformed lines and branch traversal assumes an acyclic, unique index. */
function readPiManager(path: string, directory: string) {
  const content = readFileSync(path, 'utf8')
  const lines = content.split('\n').filter((line) => line.trim().length > 0)
  const entries = parseSessionEntries(content)
  const types = entryTypeSchema.safeParse(entries)
  if (
    entries.length !== lines.length ||
    !types.success ||
    types.data[0]?.type !== 'session' ||
    types.data.filter((entry) => entry.type === 'session').length !== 1 ||
    !sessionVersionSchema.safeParse(entries[0]).success
  )
    throw new Error('Invalid native Pi session')
  // Let the public SDK supply lineage for legacy linear sessions, on decoded
  // entries only. No file or SessionManager mutation occurs before admission.
  migrateSessionEntries(entries)
  assertPiLineage(entries)
  return SessionManager.open(path, directory)
}

export async function openPiSession(
  statePath: string,
  threadID: string,
  nativeSessionID: string,
  {
    requireExisting = false,
    storage = 'legacy',
  }: Readonly<{
    requireExisting?: boolean | undefined
    storage?: 'legacy' | 'session' | undefined
  }> = {},
) {
  z.uuid().parse(threadID)
  z.uuid().parse(nativeSessionID)
  const directory =
    storage === 'session'
      ? join(statePath, 'pi', threadID, nativeSessionID)
      : join(statePath, 'pi', threadID)
  const existing = SessionManager.findById('/', nativeSessionID, directory)
  if (existing !== undefined) return readPiManager(existing, directory)
  if (requireExisting) throw new NativeStateLostError()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await readdir(directory)).some((name) => name.endsWith('.jsonl')))
    throw new Error('Assigned native Pi session is unavailable')
  return SessionManager.create('/', directory, { id: nativeSessionID })
}

function historyMessage(
  role: 'user' | 'assistant',
  message: ConversationContext['turns'][number]['output'],
) {
  return {
    role,
    text: message.text,
    sources: message.sources,
    assets: message.assets?.map(({ name, mimeType }) => ({ name, mimeType })),
  }
}

/** Public Pi custom-message text; historical facts confer no tool authority. */
function historyText(context: ConversationContext) {
  const messages: ReturnType<typeof historyMessage>[] = []
  for (const { input, output } of context.turns) {
    messages.push(historyMessage('user', input), historyMessage('assistant', output))
  }
  return `Completed conversation history (reference only):\n${JSON.stringify(messages)}`
}

const bootstrapDetailsSchema = z.strictObject({
  version: z.literal(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
})

/** Public context entry owns its digest; setup alone intentionally does not create a JSONL file. */
export function bootstrapPiSession(manager: SessionManager, context: ConversationContext) {
  const parsed = conversationContextSchema.parse(context)
  const digest = createHash('sha256').update(JSON.stringify(parsed)).digest('hex')
  // Read all entries: compaction can remove the context from the active projection,
  // but must not make an already initialized binding appear fresh.
  const entries = manager.getEntries()
  const seeds = entries
    .filter((entry) => entry.type === 'custom_message')
    .filter((entry) => entry.customType === 'platform-context')
  if (seeds.length > 1) throw new Error('Invalid native context bootstrap')
  const seed = seeds[0]
  if (seed !== undefined) {
    const details = bootstrapDetailsSchema.safeParse(seed.details)
    if (!details.success) throw new Error('Invalid native context bootstrap metadata')
    if (details.data.digest !== digest) throw new Error('Native context bootstrap conflict')
    if (seed.content !== historyText(parsed))
      throw new Error('Invalid native context bootstrap material')
    return
  }
  const path = manager.getSessionFile()
  if (entries.length > 0 || (path !== undefined && existsSync(path)))
    throw new Error('Existing native history cannot accept initial context')
  manager.appendCustomMessageEntry('platform-context', historyText(parsed), false, {
    version: 1,
    digest,
  })
}

/** Verify the SDK actually persisted its current leaf; in-memory entries alone are not a receipt. */
export async function checkpointPiSession(manager: SessionManager) {
  const path = manager.getSessionFile()
  if (path === undefined) throw new Error('Native Pi session has no persistent location')
  const file = await open(path, 'r')
  try {
    await file.sync()
    const entries = parseSessionEntries(await readFile(path, 'utf8'))
    const retained = entries.findLast((entry) => entry.type !== 'session')
    if (retained?.id !== manager.getLeafId())
      throw new Error('Native Pi session checkpoint is incomplete')
  } finally {
    await file.close()
  }
  // Persist the SDK-created JSONL directory entry as well as its contents.
  // This remains a local filesystem receipt, not a node-loss guarantee.
  const directory = await open(dirname(path), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

/** Retain only trusted business references, never infer upload authority from model/tool text. */
export function retainPiAssets(
  manager: SessionManager,
  runID: string,
  prepared: readonly AssetReference[] = [],
): readonly AssetReference[] {
  const assets = new Map<string, AssetReference>()
  for (const entry of manager.getBranch()) {
    if (entry.type !== 'custom' || entry.customType !== 'platform-asset') continue
    const receipt = assetReceiptSchema.safeParse(entry.data)
    if (!receipt.success) throw new Error('Invalid native Pi asset receipt')
    if (receipt.data.runID === runID && !assets.has(receipt.data.asset.assetID))
      assets.set(receipt.data.asset.assetID, receipt.data.asset)
  }
  for (const asset of prepared) {
    if (assets.has(asset.assetID)) continue
    const receipt = assetReceiptSchema.parse({ runID, asset })
    manager.appendCustomEntry('platform-asset', receipt)
    assets.set(receipt.asset.assetID, receipt.asset)
  }
  return [...assets.values()]
}

/** Only one product input is delivered at a time; extensions cannot independently inject inputs. */
export function hasPiInput(manager: SessionManager, runID: string) {
  const branch = manager.getBranch()
  const marker = branch.findIndex((entry) => {
    if (entry.type !== 'custom' || entry.customType !== 'platform-input') return false
    const admission = inputAdmissionSchema.safeParse(entry.data)
    if (!admission.success) throw new Error('Invalid native Pi input admission')
    return admission.data.runID === runID
  })
  if (marker < 0) {
    manager.appendCustomEntry('platform-input', { runID })
    return false
  }
  return branch
    .slice(marker + 1)
    .some((entry) => entry.type === 'message' && entry.message.role === 'user')
}

/** Final-receipt lookup must not create directories or allocate a new native session. */
export function readCompletedPiRequest(
  statePath: string,
  {
    threadID,
    nativeSessionID,
    runID,
    requireExisting = false,
    nativeSessionStorage = 'legacy',
  }: NativeRequestIdentity,
): ExecutionCompletion | undefined {
  z.uuid().parse(threadID)
  z.uuid().parse(nativeSessionID)
  const directory =
    nativeSessionStorage === 'session'
      ? join(statePath, 'pi', threadID, nativeSessionID)
      : join(statePath, 'pi', threadID)
  const existing = SessionManager.findById('/', nativeSessionID, directory)
  if (existing === undefined && requireExisting) throw new NativeStateLostError()
  return existing === undefined
    ? undefined
    : completedPiRequest(readPiManager(existing, directory), runID)
}

export function completedPiRequest(
  manager: SessionManager,
  runID: string,
): ExecutionCompletion | undefined {
  for (const entry of manager.getBranch()) {
    if (entry.type !== 'custom' || entry.customType !== 'platform-completed') continue
    const parsed = completionSchema.safeParse(entry.data)
    if (!parsed.success) throw new Error('Invalid native Pi completion')
    if (parsed.data.runID === runID) {
      const { text, sources, assets } = parsed.data.result
      return {
        text,
        ...(sources === undefined ? {} : { sources }),
        ...(assets === undefined ? {} : { assets }),
      }
    }
  }
}
