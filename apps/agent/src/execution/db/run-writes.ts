import type { DB } from '@vid/database/types'
import { sql, type Kysely, type Transaction } from 'kysely'
import type {
  ExecutionLease,
  ExecutionWrites,
  ExecutionCompletion,
  ExecutionFailure,
  ExecutionOutcome,
  SpendingDecision,
} from '../../contract'
import type { NativeSandboxReference } from '../../sandbox/reference'
import { lockLease, renewExecutionLease } from './execution-leases'
import { recordTerminal, type TerminalEvent } from './terminal-writes'
import { enqueueEvent, eventIdentities } from './event-outbox'

type LeaseState = Awaited<ReturnType<typeof lockLease>>

/** Binding contains actual writes, never SDK history or an alternate scheduler. */
export function bindExecutionWrites(db: Kysely<DB>): ExecutionWrites {
  return {
    reserveModel: (lease) => reserveModel(db, lease),
    beginEffect: (lease) => beginEffect(db, lease),
    rejectEffect: (lease) => rejectEffect(db, lease),
    checkpoint: (lease) => checkpointEffects(db, lease),
    beginWorkspaceTransition: (lease) => workspaceTransition(db, lease, true),
    settleWorkspaceTransition: (lease) => workspaceTransition(db, lease, false),
    saveSandbox: (lease, reference) => saveNativeSandbox(db, lease, reference),
    quarantine: (lease, reason) => quarantineSandbox(db, lease, reason),
    renew: (lease, leaseMs) => renewExecutionLease(db, lease, leaseMs),
    appendText: (lease, delta) => appendExecutionText(db, lease, delta),
    complete: (lease, completion) => completeExecutionRun(db, lease, completion),
    fail: (lease, reason) => failExecutionRun(db, lease, reason),
    cancel: (lease) => cancelExecutionRun(db, lease),
  }
}

function spendingDenied(run: LeaseState): SpendingDecision | undefined {
  if (run === undefined) return 'lost'
  if (run.cancel_requested) return 'cancel'
  if (run.sandbox_recovery_required || run.workspace_transition_pending) return 'recovery-required'
  if (run.deadline_at === null || run.deadline_at.getTime() <= run.now.getTime()) return 'limit'
  return undefined
}

async function reserveModel(db: Kysely<DB>, lease: ExecutionLease): Promise<SpendingDecision> {
  return await db.transaction().execute(async (tx) => {
    const run = await lockLease(tx, lease)
    if (run === undefined) return 'lost'
    const denied = spendingDenied(run)
    if (denied !== undefined) return denied
    if (run.model_call_count >= 16) return 'limit'
    await tx
      .updateTable('execution.runs')
      .set({ model_call_count: sql`model_call_count + 1` })
      .where('run_id', '=', lease.runID)
      .execute()
    return 'allowed'
  })
}

/** Persist uncertainty before dispatch, not after an effect happens. */
async function beginEffect(db: Kysely<DB>, lease: ExecutionLease): Promise<SpendingDecision> {
  return await db.transaction().execute(async (tx) => {
    const denied = spendingDenied(await lockLease(tx, lease))
    if (denied !== undefined) return denied
    await tx
      .updateTable('execution.runs')
      .set({ uncheckpointed_effects: sql`uncheckpointed_effects + 1` })
      .where('run_id', '=', lease.runID)
      .execute()
    return 'allowed'
  })
}

/** Confirmed no IO was dispatched. This never refunds a model reservation. */
async function rejectEffect(db: Kysely<DB>, lease: ExecutionLease) {
  return await db.transaction().execute(async (tx) => {
    const run = await lockLease(tx, lease, true)
    if (run === undefined || run.uncheckpointed_effects < 1) return false
    await tx
      .updateTable('execution.runs')
      .set({ uncheckpointed_effects: sql`uncheckpointed_effects - 1` })
      .where('run_id', '=', lease.runID)
      .execute()
    return true
  })
}

/** Called only after durable native results, never at a tool-start callback. */
async function checkpointEffects(db: Kysely<DB>, lease: ExecutionLease) {
  return await db.transaction().execute(async (tx) => {
    const run = await lockLease(tx, lease)
    if (run === undefined || run.sandbox_recovery_required || run.workspace_transition_pending)
      return false
    await tx
      .updateTable('execution.native_sessions')
      .set({ initialized: true })
      .where('thread_id', '=', lease.threadID)
      .where('native_session_id', '=', lease.nativeSessionID)
      .execute()
    await tx
      .updateTable('execution.conversations')
      .set({ native_state_initialized: true })
      .where('thread_id', '=', lease.threadID)
      .execute()
    await tx
      .updateTable('execution.runs')
      .set({ uncheckpointed_effects: 0 })
      .where('run_id', '=', lease.runID)
      .execute()
    return true
  })
}

/** Cleanup may settle the same expired owner, never a different fence. */
async function workspaceTransition(db: Kysely<DB>, lease: ExecutionLease, pending: boolean) {
  return await db.transaction().execute(async (tx) => {
    if ((await lockLease(tx, lease, true)) === undefined) return false
    await tx
      .updateTable('execution.conversations')
      .set({ workspace_transition_pending: pending })
      .where('thread_id', '=', lease.threadID)
      .execute()
    return true
  })
}

export async function appendExecutionText(db: Kysely<DB>, lease: ExecutionLease, delta: string) {
  return await db.transaction().execute(async (tx) => {
    const run = await lockLease(tx, lease)
    if (run === undefined || run.cancel_requested || run.sandbox_recovery_required) return false
    await enqueueEvent(tx, {
      ...eventIdentities(lease),
      kind: 'assistant-text',
      messageID: run.assistant_message_id!,
      delta,
    })
    return true
  })
}

export async function completeExecutionRun(
  db: Kysely<DB>,
  lease: ExecutionLease,
  completion: ExecutionCompletion,
): Promise<ExecutionOutcome> {
  return await db.transaction().execute((tx) => finishRun(tx, lease, { completion }))
}

export async function failExecutionRun(
  db: Kysely<DB>,
  lease: ExecutionLease,
  reason: ExecutionFailure,
): Promise<ExecutionOutcome> {
  return await db.transaction().execute((tx) =>
    finishRun(tx, lease, {
      event: { ...eventIdentities(lease), kind: 'run-failed', reason },
    }),
  )
}

export async function cancelExecutionRun(
  db: Kysely<DB>,
  lease: ExecutionLease,
): Promise<ExecutionOutcome> {
  return await db.transaction().execute((tx) =>
    finishRun(tx, lease, {
      event: { ...eventIdentities(lease), kind: 'run-cancelled' },
    }),
  )
}

async function finishRun(
  tx: Transaction<DB>,
  lease: ExecutionLease,
  decision:
    | { completion: ExecutionCompletion }
    | { event: Exclude<TerminalEvent, { kind: 'run-completed' }> },
): Promise<ExecutionOutcome> {
  const run = await lockLease(tx, lease)
  if (run === undefined) return 'lost'
  // Durable cancellation wins every terminal race, including model/config failure.
  if (run.cancel_requested)
    return await recordTerminal(tx, { ...eventIdentities(lease), kind: 'run-cancelled' })
  if ('event' in decision) return await recordTerminal(tx, decision.event)
  if (
    run.sandbox_recovery_required ||
    run.workspace_transition_pending ||
    run.uncheckpointed_effects > 0
  ) {
    await tx
      .updateTable('execution.conversations')
      .set({ sandbox_recovery_required: true })
      .where('thread_id', '=', lease.threadID)
      .execute()
    return await recordTerminal(tx, {
      ...eventIdentities(lease),
      kind: 'run-failed',
      reason: 'sandbox-recovery-required',
    })
  }
  const completion = decision.completion
  return await recordTerminal(tx, {
    ...eventIdentities(lease),
    kind: 'run-completed',
    messageID: run.assistant_message_id!,
    text: completion.text,
    ...(completion.sources === undefined ? {} : { sources: completion.sources }),
    ...(completion.assets === undefined ? {} : { assets: [...completion.assets] }),
  })
}

/** Known allocation replaces its pending lifecycle fact before inference. */
export async function saveNativeSandbox(
  db: Kysely<DB>,
  lease: ExecutionLease,
  reference: NativeSandboxReference,
) {
  return await db.transaction().execute(async (tx) => {
    const run = await lockLease(tx, lease)
    if (run === undefined || run.sandbox_recovery_required) return false
    await tx
      .updateTable('execution.conversations')
      .set({
        native_sandbox: sql`${JSON.stringify(reference)}::jsonb`,
        workspace_transition_pending: false,
        workspace_reset_required: false,
      })
      .where('thread_id', '=', lease.threadID)
      .execute()
    return true
  })
}

/** A stale physical writer may flag uncertainty, but never overwrite the new
 * native identity, fence, result, or active request. SQL alone cannot stop a VM. */
export async function quarantineSandbox(
  db: Kysely<DB>,
  lease: ExecutionLease,
  reason: ExecutionFailure = 'interrupted',
) {
  await db.transaction().execute(async (tx) => {
    await tx
      .selectFrom('execution.conversations')
      .select('thread_id')
      .where('thread_id', '=', lease.threadID)
      .forUpdate()
      .executeTakeFirstOrThrow()
    await tx
      .updateTable('execution.conversations')
      .set({ sandbox_recovery_required: true })
      .where('thread_id', '=', lease.threadID)
      .execute()
    // Keep ownership through actual cleanup. The current owner's normal
    // terminal transaction alone chooses failed/cancelled and releases it.
    console.error({ stage: 'workspace-quarantine', runID: lease.runID, fence: lease.fence, reason })
  })
}
