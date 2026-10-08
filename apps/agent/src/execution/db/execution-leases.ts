import type { DB } from '@vid/database/types'
import { sql, type Kysely, type Transaction, type Selectable } from 'kysely'
import { executionEventSchema, startCommandSchema } from '@vid/contract/execution'
import type { AgentHarness, ExecutionLease, HarnessEngine } from '../../contract'
import { recordTerminal } from './terminal-writes'
import { enqueueEvent, eventIdentities } from './event-outbox'
import { sandboxReferenceFromJSON } from '../../sandbox/reference'
import {
  bindRunSession,
  prepareHarnessSelection,
  readNativeRequestIdentity,
  type HarnessSelection,
} from './session-bindings'

const conversationColumns = [
  'thread_id',
  'active_run_id',
  'fence',
  'harness_engine',
  'requested_engine',
  'lease_owner',
  'lease_until',
  'native_session_id',
  'native_state_initialized',
  'legacy_import_required',
  'native_sandbox',
  'sandbox_recovery_required',
  'workspace_reset_required',
  'workspace_transition_pending',
] as const

export type ClaimOptions = Readonly<{
  ownerID: string
  leaseMs: number
  defaultEngine?: HarnessEngine
  getCompleted?: AgentHarness['completed']
  requestTimeoutMs?: number
}>

export async function claimExecutionRun(
  db: Kysely<DB>,
  options: ClaimOptions,
): Promise<ExecutionLease | null> {
  const selection = await prepareHarnessSelection(db, options)
  return await db.transaction().execute(async (tx) => {
    // Expiry alone cannot prove a physical writer stopped. Only startup recovery,
    // while holding the native storage's kernel lock, may release interrupted work.
    const conversation = await tx
      .selectFrom('execution.conversations')
      .select(conversationColumns)
      .where('active_run_id', 'is', null)
      .where((where) =>
        selection === undefined ? where.val(true) : where('thread_id', '=', selection.threadID),
      )
      .where(
        sql<boolean>`exists (select 1 from execution.runs r where r.thread_id = execution.conversations.thread_id and r.status = 'queued')`,
      )
      .orderBy('thread_id')
      .limit(1)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst()
    if (conversation === undefined) return null
    if (conversation.sandbox_recovery_required || conversation.workspace_transition_pending) {
      await rejectQueuedRuns(tx, conversation.thread_id, 'sandbox-recovery-required')
      return null
    }
    if (conversation.legacy_import_required) {
      await rejectQueuedRuns(tx, conversation.thread_id, 'execution-error')
      return null
    }
    const run = await tx
      .selectFrom('execution.runs')
      .selectAll()
      .where('thread_id', '=', conversation.thread_id)
      .where('status', '=', 'queued')
      .orderBy('created_at')
      .orderBy('run_id')
      .limit(1)
      .forUpdate()
      .executeTakeFirst()
    if (run === undefined) return null
    // An intent may commit after the unlocked preparation query. Leave fresh
    // work queued until its source can be validated; never erase accepted intent.
    if (
      run.native_session_id === null &&
      conversation.requested_engine !== null &&
      selection === undefined
    )
      return null
    if (run.cancel_requested) {
      await finishInterrupted(
        tx,
        { threadID: conversation.thread_id, runID: run.run_id },
        { status: 'cancelled' },
      )
      return null
    }
    return await assignNativeLease(tx, conversation, run, { ...options, selection })
  })
}

type LockedConversation = Pick<
  Selectable<DB['execution.conversations']>,
  (typeof conversationColumns)[number]
>

async function acceptedInput(
  tx: Transaction<DB>,
  conversation: LockedConversation,
  run: Selectable<DB['execution.runs']>,
) {
  const inbox = await tx
    .selectFrom('execution.command_inbox')
    .select('command')
    .where('command_id', '=', run.command_id)
    .executeTakeFirstOrThrow()
  const command = startCommandSchema.parse(inbox.command)
  if (
    command.commandID !== run.command_id ||
    command.threadID !== conversation.thread_id ||
    command.runID !== run.run_id ||
    command.input.messageID !== run.message_id ||
    command.input.text !== run.text
  )
    throw new Error('Accepted input does not match assigned request')
  return command.input
}

async function assignNativeLease(
  tx: Transaction<DB>,
  conversation: LockedConversation,
  run: Selectable<DB['execution.runs']>,
  options: ClaimOptions & { selection: HarnessSelection | undefined },
): Promise<ExecutionLease> {
  // Sample after both locks; waiting for a run lock cannot extend an old clock.
  const now = await databaseNow(tx)
  const input = await acceptedInput(tx, conversation, run)
  const fence = conversation.fence + 1
  const session = await bindRunSession(
    tx,
    {
      threadID: conversation.thread_id,
      runID: run.run_id,
      runSessionID: run.native_session_id,
      currentSessionID: conversation.native_session_id,
      currentEngine: conversation.harness_engine,
      initialized: conversation.native_state_initialized,
      requestedEngine: conversation.requested_engine,
      fence: conversation.fence,
    },
    { defaultEngine: options.defaultEngine, selection: options.selection },
  )
  const deadlineAt =
    run.deadline_at ?? new Date(now.getTime() + (options.requestTimeoutMs ?? 1800000))
  const assistantMessageID = run.assistant_message_id ?? crypto.randomUUID()
  await tx
    .updateTable('execution.conversations')
    .set({
      active_run_id: run.run_id,
      native_state_initialized: session.requireExisting,
      fence,
      lease_owner: options.ownerID,
      lease_until: new Date(now.getTime() + options.leaseMs),
    })
    .where('thread_id', '=', conversation.thread_id)
    .execute()
  await tx
    .updateTable('execution.runs')
    .set({
      status: 'running',
      assistant_message_id: assistantMessageID,
      deadline_at: deadlineAt,
    })
    .where('run_id', '=', run.run_id)
    .execute()
  if (run.assistant_message_id === null)
    await enqueueEvent(tx, {
      ...eventIdentities({ threadID: conversation.thread_id, runID: run.run_id }),
      kind: 'run-started',
    })
  return {
    threadID: conversation.thread_id,
    runID: run.run_id,
    text: run.text,
    ...session,
    deadlineAt,
    restoring: run.resume_count > 0,
    restoreWorkspace: conversation.workspace_reset_required,
    ownerID: options.ownerID,
    fence,
    ...(input.assets === undefined ? {} : { assets: input.assets }),
    ...(conversation.native_sandbox === null
      ? {}
      : { nativeRef: sandboxReferenceFromJSON(conversation.native_sandbox)! }),
  }
}

/** Caller must hold the exclusive native-state kernel lock for the entire worker
 * lifetime. This proves prior worker processes stopped, not prior guest writers:
 * the next owner must cold-settle the known guest before it opens native state.
 * Lifecycle uncertainty remains operator-reconciled. Uncheckpointed effects
 * require either a durable native final with observed results or reconciliation.
 */
export async function recoverNativeRequests(
  db: Kysely<DB>,
  getCompleted?: AgentHarness['completed'],
) {
  // Native IO holds only the caller's lifetime kernel lock, never SQL locks.
  // Each original authority is visited once: a changed owner is not a new retry.
  const conversations = await db
    .selectFrom('execution.conversations')
    .select(conversationColumns)
    .where('active_run_id', 'is not', null)
    .orderBy('thread_id')
    .execute()
  for (const snapshot of conversations) {
    // An earlier conversation's IO may have allowed cancellation/quarantine here.
    const readable = await db
      .selectFrom('execution.conversations')
      .select(conversationColumns)
      .where('thread_id', '=', snapshot.thread_id)
      .executeTakeFirst()
    if (readable === undefined || !matchesRecovery(readable, snapshot)) continue
    const run = await db
      .selectFrom('execution.runs')
      .selectAll()
      .where('run_id', '=', snapshot.active_run_id!)
      .where('thread_id', '=', snapshot.thread_id)
      .executeTakeFirstOrThrow()
    const completion =
      getCompleted !== undefined && canReadCompleted(readable, run)
        ? await getCompleted(
            await readNativeRequestIdentity(db, {
              threadID: readable.thread_id,
              runID: run.run_id,
            }),
          )
        : undefined
    await db.transaction().execute(async (tx) => {
      const conversation = await tx
        .selectFrom('execution.conversations')
        .select(conversationColumns)
        .where('thread_id', '=', snapshot.thread_id)
        .forUpdate()
        .executeTakeFirst()
      if (conversation === undefined || !matchesRecovery(conversation, snapshot)) return
      await recoverInterruptedRequest(tx, conversation, completion)
    })
  }
}

async function recoverInterruptedRequest(
  tx: Transaction<DB>,
  conversation: LockedConversation,
  completion: NativeCompletion,
) {
  const run = await tx
    .selectFrom('execution.runs')
    .selectAll()
    .where('run_id', '=', conversation.active_run_id!)
    .where('thread_id', '=', conversation.thread_id)
    .forUpdate()
    .executeTakeFirstOrThrow()
  if (run.status !== 'running') return
  if (await recoverCompleted(tx, conversation, run, completion)) return
  const uncertain = workspaceUncertain(conversation) || run.uncheckpointed_effects > 0
  // Fresh after native IO and both locks, immediately before continuation.
  const now = await databaseNow(tx)
  if (canResume(run, uncertain || conversation.legacy_import_required, now)) {
    await tx
      .updateTable('execution.runs')
      .set({ status: 'queued', resume_count: run.resume_count + 1 })
      .where('run_id', '=', run.run_id)
      .execute()
  } else {
    await finishInterrupted(
      tx,
      { threadID: conversation.thread_id, runID: run.run_id },
      {
        status: run.cancel_requested ? 'cancelled' : 'failed',
        reason: uncertain ? 'sandbox-recovery-required' : 'interrupted',
      },
    )
  }
  await tx
    .updateTable('execution.conversations')
    .set({
      active_run_id: null,
      lease_owner: null,
      lease_until: null,
      fence: conversation.fence + 1,
      workspace_reset_required: true,
      sandbox_recovery_required: uncertain,
    })
    .where('thread_id', '=', conversation.thread_id)
    .execute()
  if (uncertain) await rejectQueuedRuns(tx, conversation.thread_id, 'sandbox-recovery-required')
}

function workspaceUncertain(
  conversation: Pick<
    Selectable<DB['execution.conversations']>,
    'sandbox_recovery_required' | 'workspace_transition_pending'
  >,
) {
  return conversation.sandbox_recovery_required || conversation.workspace_transition_pending
}

function canResume(run: Selectable<DB['execution.runs']>, uncertain: boolean, now: Date) {
  return (
    run.status === 'running' &&
    !run.cancel_requested &&
    !uncertain &&
    run.resume_count < 2 &&
    run.model_call_count < 16 &&
    run.deadline_at !== null &&
    run.deadline_at.getTime() > now.getTime()
  )
}

type NativeCompletion = Awaited<ReturnType<NonNullable<AgentHarness['completed']>>>

function matchesRecovery(current: LockedConversation, snapshot: LockedConversation) {
  return (
    current.active_run_id === snapshot.active_run_id &&
    current.fence === snapshot.fence &&
    current.harness_engine === snapshot.harness_engine &&
    current.native_session_id === snapshot.native_session_id &&
    current.native_state_initialized === snapshot.native_state_initialized
  )
}

function canReadCompleted(conversation: LockedConversation, run: Selectable<DB['execution.runs']>) {
  return (
    run.status === 'running' &&
    !run.cancel_requested &&
    !workspaceUncertain(conversation) &&
    !conversation.legacy_import_required
  )
}

/** Publish only under fresh locked SQL authority. A durable final proves observed
 * tool results after a lost checkpoint ACK, not guest lifecycle or workspace safety.
 */
async function recoverCompleted(
  tx: Transaction<DB>,
  conversation: LockedConversation,
  run: Selectable<DB['execution.runs']>,
  completion: NativeCompletion,
) {
  if (completion === undefined || !canReadCompleted(conversation, run)) return false
  const event = executionEventSchema.parse({
    ...eventIdentities({ threadID: conversation.thread_id, runID: run.run_id }),
    ...completion,
    kind: 'run-completed',
    messageID: run.assistant_message_id,
  })
  if (event.kind !== 'run-completed') throw new Error('Invalid native completion')
  await tx
    .updateTable('execution.runs')
    .set({ uncheckpointed_effects: 0 })
    .where('run_id', '=', run.run_id)
    .execute()
  await recordTerminal(tx, event)
  await tx
    .updateTable('execution.conversations')
    .set({
      fence: conversation.fence + 1,
      workspace_reset_required: true,
    })
    .where('thread_id', '=', conversation.thread_id)
    .execute()
  return true
}

function matchesLease(
  conversation: Pick<
    Selectable<DB['execution.conversations']>,
    'active_run_id' | 'lease_owner' | 'fence' | 'harness_engine' | 'native_session_id'
  >,
  lease: ExecutionLease,
) {
  return (
    conversation.active_run_id === lease.runID.toLowerCase() &&
    conversation.lease_owner === lease.ownerID &&
    conversation.fence === lease.fence &&
    conversation.harness_engine === lease.engine &&
    conversation.native_session_id === lease.nativeSessionID.toLowerCase()
  )
}

/** Conversation then run, with database time sampled only after the lock. */
export async function lockLease(tx: Transaction<DB>, lease: ExecutionLease, allowExpired = false) {
  const conversation = await tx
    .selectFrom('execution.conversations')
    .select([
      'active_run_id',
      'fence',
      'lease_owner',
      'lease_until',
      'harness_engine',
      'native_session_id',
      'sandbox_recovery_required',
      'workspace_transition_pending',
    ])
    .where('thread_id', '=', lease.threadID)
    .forUpdate()
    .executeTakeFirst()
  if (
    conversation === undefined ||
    !matchesLease(conversation, lease) ||
    conversation.lease_until === null
  )
    return undefined
  const run = await tx
    .selectFrom('execution.runs')
    .select([
      'assistant_message_id',
      'status',
      'cancel_requested',
      'model_call_count',
      'uncheckpointed_effects',
      'deadline_at',
    ])
    .where('thread_id', '=', lease.threadID)
    .where('run_id', '=', lease.runID)
    .forUpdate()
    .executeTakeFirst()
  const now = await databaseNow(tx)
  if (!allowExpired && conversation.lease_until.getTime() <= now.getTime()) return undefined
  if (run?.status !== 'running') return undefined
  return {
    ...run,
    now,
    sandbox_recovery_required: conversation.sandbox_recovery_required,
    workspace_transition_pending: conversation.workspace_transition_pending,
  }
}

export async function renewExecutionLease(db: Kysely<DB>, lease: ExecutionLease, leaseMs: number) {
  return await db.transaction().execute(async (tx) => {
    const run = await lockLease(tx, lease)
    if (run === undefined) return 'lost' as const
    // Cancellation and uncertainty stop spending, not ownership of cleanup.
    await tx
      .updateTable('execution.conversations')
      .set({ lease_until: new Date(run.now.getTime() + leaseMs) })
      .where('thread_id', '=', lease.threadID)
      .execute()
    if (run.cancel_requested) return 'cancel' as const
    if (run.sandbox_recovery_required) return 'recovery-required' as const
    return 'renewed' as const
  })
}

async function databaseNow(tx: Transaction<DB>) {
  return (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(tx)).rows[0]!.now
}

async function finishInterrupted(
  tx: Transaction<DB>,
  identity: { threadID: string; runID: string },
  outcome: {
    status: 'failed' | 'cancelled'
    reason?: 'interrupted' | 'sandbox-recovery-required'
  },
) {
  await tx
    .updateTable('execution.runs')
    .set({ status: outcome.status })
    .where('run_id', '=', identity.runID)
    .execute()
  await enqueueEvent(tx, {
    ...eventIdentities(identity),
    ...(outcome.status === 'cancelled'
      ? { kind: 'run-cancelled' as const }
      : { kind: 'run-failed' as const, reason: outcome.reason ?? 'interrupted' }),
  })
}

/** Accepted work receives a durable explicit terminal, never silently disappears. */
async function rejectQueuedRuns(
  tx: Transaction<DB>,
  threadID: string,
  reason: 'execution-error' | 'sandbox-recovery-required',
) {
  const runs = await tx
    .updateTable('execution.runs')
    .set({ status: 'failed' })
    .where('thread_id', '=', threadID)
    .where('status', '=', 'queued')
    .returning('run_id')
    .execute()
  for (const run of runs)
    await enqueueEvent(tx, {
      ...eventIdentities({ threadID, runID: run.run_id }),
      kind: 'run-failed',
      reason,
    })
}
