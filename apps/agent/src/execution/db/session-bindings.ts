import { sql, type Kysely, type Transaction } from 'kysely'
import type { DB } from '@vid/database/types'
import {
  conversationContextSchema,
  type ConversationContext,
} from '@vid/contract/conversation-context'
import type { AgentHarness, HarnessEngine, NativeRequestIdentity } from '../../contract'
import { buildConversationContext } from './conversation-context'

export type HarnessSelection = Readonly<{
  threadID: string
  nativeSessionID: string
  engine: HarnessEngine
  requestedEngine: string | null
  fence: number
  context: ConversationContext | undefined
}>

const selectionColumns = [
  'thread_id',
  'native_session_id',
  'harness_engine',
  'requested_engine',
  'fence',
  'active_run_id',
  'legacy_import_required',
  'sandbox_recovery_required',
  'workspace_transition_pending',
] as const

type SelectionOptions = Readonly<{
  getCompleted?: AgentHarness['completed']
}>

/** Operator intent only. The worker validates the native source before a fresh
 * run consumes this selection; this does not modify any accepted run binding. */
export async function requestHarness(
  db: Kysely<DB>,
  input: Readonly<{ threadID: string; nativeSessionID: string; engine: HarnessEngine }>,
) {
  return await db.transaction().execute(async (tx) => {
    const conversation = await tx
      .selectFrom('execution.conversations')
      .select(selectionColumns)
      .where('thread_id', '=', input.threadID)
      .forUpdate()
      .executeTakeFirstOrThrow()
    if (conversation.native_session_id !== input.nativeSessionID)
      throw new Error('Harness selection conflicts with the current native binding')
    if (conversation.active_run_id !== null)
      throw new Error('Harness selection requires a settled request')
    if (requiresRecovery(conversation))
      throw new Error('Harness selection requires explicit recovery')
    if (conversation.requested_engine === input.engine) return 'replay' as const
    if (conversation.requested_engine !== null)
      throw new Error('Harness selection conflicts with a pending selection')
    if (conversation.harness_engine === input.engine) return 'replay' as const
    await tx
      .updateTable('execution.conversations')
      .set({ requested_engine: input.engine })
      .where('thread_id', '=', input.threadID)
      .execute()
    return 'accepted' as const
  })
}

/** Native IO stays outside SQL locks. Caller owns the root lifetime flock and
 * has joined prior writers; an expired lease or terminal alone is insufficient. */
export async function prepareHarnessSelection(db: Kysely<DB>, options: SelectionOptions) {
  const source = await db
    .selectFrom('execution.conversations')
    .select(selectionColumns)
    .where('active_run_id', 'is', null)
    .where(
      sql<boolean>`(select r.native_session_id is null from execution.runs r
          where r.thread_id = execution.conversations.thread_id and r.status = 'queued'
          order by r.created_at, r.run_id limit 1)`,
    )
    .where('requested_engine', 'is not', null)
    .orderBy('thread_id')
    .limit(1)
    .executeTakeFirst()
  if (source === undefined) return undefined
  const engine = source.requested_engine
  if (engine !== 'pi' && engine !== 'openai') throw new Error('Invalid requested harness engine')
  if (requiresRecovery(source)) throw new Error('Harness selection requires explicit recovery')
  let context: ConversationContext | undefined
  if (source.harness_engine !== null && source.harness_engine !== engine) {
    await validateNativeSource(db, source, options.getCompleted)
    context = await buildConversationContext(db, source.thread_id)
  }
  return {
    threadID: source.thread_id,
    nativeSessionID: source.native_session_id,
    requestedEngine: source.requested_engine,
    fence: source.fence,
    engine,
    context,
  } satisfies HarnessSelection
}

function requiresRecovery(
  conversation: Readonly<{
    legacy_import_required: boolean
    sandbox_recovery_required: boolean
    workspace_transition_pending: boolean
  }>,
) {
  return (
    conversation.legacy_import_required ||
    conversation.sandbox_recovery_required ||
    conversation.workspace_transition_pending
  )
}

async function validateNativeSource(
  db: Kysely<DB>,
  source: Readonly<{
    thread_id: string
    native_session_id: string
  }>,
  getCompleted: AgentHarness['completed'],
) {
  const run = await db
    .selectFrom('execution.runs')
    .select(['run_id', 'status', 'uncheckpointed_effects'])
    .where('thread_id', '=', source.thread_id)
    .where('native_session_id', '=', source.native_session_id)
    .orderBy('created_at', 'desc')
    .orderBy('run_id', 'desc')
    .limit(1)
    .executeTakeFirst()
  if (run === undefined || run.status !== 'completed' || run.uncheckpointed_effects !== 0)
    throw new Error('Harness selection requires a completed native source')
  if (getCompleted === undefined) throw new Error('Harness selection requires native validation')
  const identity = await readNativeRequestIdentity(db, {
    threadID: source.thread_id,
    runID: run.run_id,
  })
  // The immutable binding owns monotonic initialization proof; a stale current
  // pointer mirror cannot weaken the original native history requirement.
  const completion = await getCompleted(identity)
  if (completion === undefined) throw new Error('Completed native source is unavailable')
}

export async function readNativeRequestIdentity(
  db: Kysely<DB>,
  input: Readonly<{ threadID: string; runID: string }>,
): Promise<NativeRequestIdentity> {
  const session = await db
    .selectFrom('execution.runs as run')
    .innerJoin('execution.native_sessions as session', (join) =>
      join
        .onRef('session.native_session_id', '=', 'run.native_session_id')
        .onRef('session.thread_id', '=', 'run.thread_id'),
    )
    .select([
      'session.harness_engine',
      'session.storage',
      'session.native_session_id',
      'session.initialized',
    ])
    .where('run.thread_id', '=', input.threadID)
    .where('run.run_id', '=', input.runID)
    .executeTakeFirstOrThrow()
  const parsed = sessionFacts(session)
  return {
    threadID: input.threadID,
    runID: input.runID,
    engine: parsed.engine,
    nativeSessionID: session.native_session_id,
    nativeSessionStorage: parsed.storage,
    requireExisting: session.initialized,
  }
}

function sessionFacts(session: Readonly<{ harness_engine: string; storage: string }>): {
  engine: HarnessEngine
  storage: 'legacy' | 'session'
} {
  if (session.harness_engine !== 'pi' && session.harness_engine !== 'openai')
    throw new Error('Invalid assigned native engine')
  if (session.storage !== 'legacy' && session.storage !== 'session')
    throw new Error('Invalid native session storage')
  return { engine: session.harness_engine, storage: session.storage }
}

/** Conversation and run are already locked. Bindings outlive changes to the
 * current pointer; a resumed run never consumes another executor selection. */
export async function bindRunSession(
  tx: Transaction<DB>,
  input: Readonly<{
    threadID: string
    runID: string
    runSessionID: string | null
    currentSessionID: string
    currentEngine: string | null
    initialized: boolean
    requestedEngine: string | null
    fence: number
  }>,
  choice: Readonly<{
    defaultEngine: HarnessEngine | undefined
    selection: HarnessSelection | undefined
  }>,
) {
  if (input.runSessionID !== null)
    return await assignedSession(tx, input.threadID, input.runSessionID)
  const engine = selectedSessionEngine(input, choice)
  const replacing = input.currentEngine !== null && input.currentEngine !== engine
  const sessionID = replacing ? crypto.randomUUID() : input.currentSessionID
  let context: ConversationContext | null = null
  if (replacing) {
    const selection = choice.selection
    if (selection === undefined || selection.context === undefined)
      throw new Error('Harness selection requires a completed context snapshot')
    context = selection.context
  }
  await tx
    .insertInto('execution.native_sessions')
    .values({
      thread_id: input.threadID,
      native_session_id: sessionID,
      harness_engine: engine,
      storage: replacing ? 'session' : 'legacy',
      initialized: replacing ? false : input.initialized,
      initial_context: context === null ? null : sql`${JSON.stringify(context)}::jsonb`,
    })
    .onConflict((conflict) =>
      conflict.column('native_session_id').doUpdateSet({
        initialized: sql<boolean>`execution.native_sessions.initialized OR excluded.initialized`,
      }),
    )
    .execute()
  await tx
    .updateTable('execution.runs')
    .set({ native_session_id: sessionID })
    .where('run_id', '=', input.runID)
    .execute()
  await tx
    .updateTable('execution.conversations')
    .set({
      harness_engine: engine,
      native_session_id: sessionID,
      requested_engine: null,
    })
    .where('thread_id', '=', input.threadID)
    .execute()
  return await assignedSession(tx, input.threadID, sessionID)
}

function selectedSessionEngine(
  input: Readonly<{
    threadID: string
    currentSessionID: string
    currentEngine: string | null
    requestedEngine: string | null
    fence: number
  }>,
  choice: Readonly<{
    defaultEngine: HarnessEngine | undefined
    selection: HarnessSelection | undefined
  }>,
): HarnessEngine {
  const selection = choice.selection
  if (selection !== undefined && !matchesSelection(input, selection))
    throw new Error('Harness selection source changed before admission')
  const candidate = selection === undefined ? input.currentEngine : selection.engine
  const engine = candidate ?? choice.defaultEngine ?? 'pi'
  if (engine !== 'pi' && engine !== 'openai') throw new Error('Invalid assigned native engine')
  return engine
}

function matchesSelection(
  input: Readonly<{
    threadID: string
    currentSessionID: string
    fence: number
    requestedEngine: string | null
  }>,
  selection: HarnessSelection,
) {
  return (
    selection.threadID === input.threadID &&
    selection.nativeSessionID === input.currentSessionID &&
    selection.fence === input.fence &&
    selection.requestedEngine === input.requestedEngine
  )
}

async function assignedSession(tx: Transaction<DB>, threadID: string, nativeSessionID: string) {
  const session = await tx
    .selectFrom('execution.native_sessions')
    .select(['harness_engine', 'storage', 'initial_context', 'initialized'])
    .where('thread_id', '=', threadID)
    .where('native_session_id', '=', nativeSessionID)
    .executeTakeFirstOrThrow()
  const { engine, storage } = sessionFacts(session)
  const initialContext =
    session.initial_context === null
      ? undefined
      : conversationContextSchema.parse(session.initial_context)
  return {
    engine,
    nativeSessionID,
    nativeSessionStorage: storage,
    requireExisting: session.initialized,
    initialContext,
  }
}
