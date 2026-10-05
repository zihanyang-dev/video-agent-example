import type { DB } from '@vid/database/types'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { ExecutionEvent } from '@vid/contract/execution'
import type {
  ExecutionLease,
  ExecutionWrites,
  ExecutionCompletion,
  ExecutionFailure,
  NativeSandboxReference,
} from '../execute-run'
import {
  lockLease,
  releaseConversation,
  renewExecutionLease,
} from './execution-leases'
import { enqueueEvent, eventIdentities } from './event-outbox'

/** Only execution's actual writes are bound here. Intake and scheduling use named
 * DB operations directly, rather than a factory object that owns every query.
 */
export function bindExecutionWrites(db: Kysely<DB>): ExecutionWrites {
  return {
    saveSandbox: (lease, reference) => saveNativeSandbox(db, lease, reference),
    quarantine: (lease, reason) => quarantineSandbox(db, lease, reason),
    renew: (lease, leaseMs) => renewExecutionLease(db, lease, leaseMs),
    appendText: (lease, delta) => appendExecutionText(db, lease, delta),
    complete: (lease, completion) =>
      completeExecutionRun(db, lease, completion),
    fail: (lease, reason) => failExecutionRun(db, lease, reason),
    cancel: (lease) => cancelExecutionRun(db, lease),
  }
}

export async function appendExecutionText(
  db: Kysely<DB>,
  lease: ExecutionLease,
  text: string,
) {
  return await db.transaction().execute((tx) => appendText(tx, lease, text))
}

export async function completeExecutionRun(
  db: Kysely<DB>,
  lease: ExecutionLease,
  completion: ExecutionCompletion,
) {
  return await db
    .transaction()
    .execute((tx) => completeRun(tx, lease, completion))
}

export async function failExecutionRun(
  db: Kysely<DB>,
  lease: ExecutionLease,
  reason: ExecutionFailure,
) {
  return await db.transaction().execute((tx) =>
    finishLease(tx, lease, {
      ...eventIdentities(lease),
      kind: 'run-failed',
      reason,
    }),
  )
}

export async function cancelExecutionRun(
  db: Kysely<DB>,
  lease: ExecutionLease,
) {
  return await db.transaction().execute((tx) =>
    finishLease(tx, lease, {
      ...eventIdentities(lease),
      kind: 'run-cancelled',
    }),
  )
}

async function appendText(
  tx: Transaction<DB>,
  lease: ExecutionLease,
  delta: string,
) {
  const run = await lockLease(tx, lease)
  if (
    run === undefined ||
    run.cancel_requested ||
    run.sandbox_recovery_required
  ) {
    return false
  }
  await enqueueEvent(tx, {
    ...eventIdentities(lease),
    kind: 'assistant-text',
    // Claim assigns this identity atomically with running status. It is read
    // under lease authority, never supplied by a streaming or terminal caller.
    messageID: run.assistant_message_id!,
    delta,
  })
  return true
}

async function completeRun(
  tx: Transaction<DB>,
  lease: ExecutionLease,
  input: ExecutionCompletion,
) {
  const run = await lockLease(tx, lease)
  if (
    run === undefined ||
    run.cancel_requested ||
    run.sandbox_recovery_required
  ) {
    return false
  }
  // History is opaque JSON owned by execution. Never interpret it as product messages,
  // and never include it in the event outbox or accept it from browser submissions.
  await tx
    .updateTable('execution.conversations')
    .set({
      history: sql`${JSON.stringify(input.history)}::jsonb`,
    })
    .where('thread_id', '=', lease.threadID)
    .execute()
  await recordTerminal(tx, {
    ...eventIdentities(lease),
    kind: 'run-completed',
    // Claim assigns this identity atomically with running status. It is read
    // under lease authority, never supplied by a streaming or terminal caller.
    messageID: run.assistant_message_id!,
    text: input.text,
    ...(input.assets === undefined ? {} : { assets: [...input.assets] }),
  })
  return true
}

async function finishLease(
  tx: Transaction<DB>,
  lease: ExecutionLease,
  event: Extract<ExecutionEvent, { kind: 'run-failed' | 'run-cancelled' }>,
) {
  const run = await lockLease(tx, lease)
  if (run === undefined) return false
  if (
    run.sandbox_recovery_required &&
    (event.kind !== 'run-failed' || event.reason !== 'execution-error')
  )
    return false
  // Cleanup/execution failure outranks cancellation; shutdown interruption does
  // not. The locked lease still fences both outcomes against stale workers.
  if (
    run.cancel_requested &&
    event.kind === 'run-failed' &&
    event.reason !== 'execution-error'
  )
    return false
  await recordTerminal(tx, event)
  return true
}

async function recordTerminal(
  tx: Transaction<DB>,
  event: Extract<
    ExecutionEvent,
    { kind: 'run-completed' | 'run-failed' | 'run-cancelled' }
  >,
) {
  const status = {
    'run-completed': 'completed',
    'run-failed': 'failed',
    'run-cancelled': 'cancelled',
  } as const
  await tx
    .updateTable('execution.runs')
    .set({ status: status[event.kind] })
    .where('run_id', '=', event.runID)
    .execute()
  await enqueueEvent(tx, event)
  await releaseConversation(tx, event.threadID)
}

/** Persist allocation before inference. A stale capability can never replace an identity. */
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
      .set({ native_sandbox: sql`${JSON.stringify(reference)}::jsonb` })
      .where('thread_id', '=', lease.threadID)
      .execute()
    return true
  })
}

/** SQL cannot fence a VM. Even a late old worker may quarantine, but must not
 * overwrite a newer fence's run/history/reference. The flag and interruption
 * are atomic when this is still the active run; expiry uses the same policy. */
export async function quarantineSandbox(
  db: Kysely<DB>,
  lease: ExecutionLease,
  reason: 'execution-error' | 'interrupted' = 'interrupted',
) {
  await db.transaction().execute(async (tx) => {
    const conversation = await tx
      .selectFrom('execution.conversations')
      .select(['active_run_id', 'fence'])
      .where('thread_id', '=', lease.threadID)
      .forUpdate()
      .executeTakeFirstOrThrow()
    await tx
      .updateTable('execution.conversations')
      .set({ sandbox_recovery_required: true })
      .where('thread_id', '=', lease.threadID)
      .execute()
    if (
      conversation.active_run_id !== lease.runID ||
      conversation.fence !== lease.fence
    )
      return
    await recordTerminal(tx, {
      ...eventIdentities(lease),
      kind: 'run-failed',
      reason,
    })
  })
}
