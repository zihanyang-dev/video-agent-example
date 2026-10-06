import { startCommandSchema } from '@vid/contract/execution'
import { sandboxReferenceFromJSON } from '../sandbox/reference'
import type { DB } from '@vid/database/types'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { ExecutionLease } from '../execute-run'
import { enqueueEvent, eventIdentities } from './event-outbox'

type ClaimOptions = Readonly<{ ownerID: string; leaseMs: number }>

// PostgreSQL-rendered UTF8 JSON, not compressed TOAST storage. Oversize history
// remains private recovery evidence; it is never truncated or paid-compacted.
export const historyByteLimit = 4 * 1024 * 1024

/** Lock a conversation before selecting its queued run and advancing the fence.
 * Expired spending is interrupted in this same transaction, never requeued.
 */
export async function claimExecutionRun(db: Kysely<DB>, options: ClaimOptions) {
  return await db.transaction().execute((tx) => claimRun(tx, options))
}

/** Renewal uses post-lock database time, and continues to grant ownership during
 * cancellation cleanup. Returning cancel is not permission to release the lease.
 */
export async function renewExecutionLease(
  db: Kysely<DB>,
  lease: ExecutionLease,
  leaseMs: number,
) {
  return await db.transaction().execute((tx) => renewLease(tx, lease, leaseMs))
}

async function claimRun(
  tx: Transaction<DB>,
  options: ClaimOptions,
): Promise<ExecutionLease | null> {
  const conversation = await lockClaimableConversation(tx)
  if (conversation === undefined) return null
  if (conversation.active_run_id !== null) {
    await interruptRun(tx, {
      threadID: conversation.thread_id,
      runID: conversation.active_run_id,
    })
    await tx
      .updateTable('execution.conversations')
      .set({ sandbox_recovery_required: true })
      .where('thread_id', '=', conversation.thread_id)
      .execute()
  }
  if (
    conversation.sandbox_recovery_required ||
    conversation.active_run_id !== null
  ) {
    await rejectQueuedRuns(
      tx,
      conversation.thread_id,
      'sandbox-recovery-required',
    )
    return null
  }
  // Read after the conversation lock, and do not transfer oversized JSON into
  // the worker. Refuse before issuing any lease/allocation/inference capability.
  const retained = await tx
    .selectFrom('execution.conversations')
    .select([
      sql<unknown>`case when octet_length(history::text) <= ${historyByteLimit}
        then history else 'null'::jsonb end`.as('history'),
      sql<boolean>`octet_length(history::text) > ${historyByteLimit}`.as(
        'history_rejected',
      ),
    ])
    .where('thread_id', '=', conversation.thread_id)
    .executeTakeFirstOrThrow()
  if (retained.history_rejected) {
    await rejectQueuedRuns(tx, conversation.thread_id, 'execution-error')
    return null
  }
  const run = await tx
    .selectFrom('execution.runs')
    .select(['run_id', 'command_id', 'text'])
    .where('thread_id', '=', conversation.thread_id)
    .where('status', '=', 'queued')
    .orderBy('created_at')
    .orderBy('run_id')
    .limit(1)
    .executeTakeFirst()
  if (run === undefined) return null
  const input = await acceptedRunInput(tx, run.command_id)
  const nativeRef = sandboxReferenceFromJSON(conversation.native_sandbox)
  const assistantMessageID = crypto.randomUUID()
  const claimed = await tx
    .updateTable('execution.conversations')
    .set({
      active_run_id: run.run_id,
      lease_owner: options.ownerID,
      lease_until: leaseDeadline(options.leaseMs),
      fence: sql`fence + 1`,
    })
    .where('thread_id', '=', conversation.thread_id)
    .returning('fence')
    .executeTakeFirstOrThrow()
  await tx
    .updateTable('execution.runs')
    .set({ status: 'running', assistant_message_id: assistantMessageID })
    .where('run_id', '=', run.run_id)
    .execute()
  const lease = Object.freeze({
    runID: run.run_id,
    threadID: conversation.thread_id,
    text: run.text,
    ownerID: options.ownerID,
    fence: claimed.fence,
    history: retained.history,
    ...(input.assets === undefined ? {} : { assets: input.assets }),
    ...(nativeRef === undefined ? {} : { nativeRef }),
  })
  await enqueueEvent(tx, { ...eventIdentities(lease), kind: 'run-started' })
  return lease
}

async function acceptedRunInput(tx: Transaction<DB>, commandID: string) {
  const accepted = await tx
    .selectFrom('execution.command_inbox')
    .select('command')
    .where('command_id', '=', commandID)
    .executeTakeFirstOrThrow()
  return startCommandSchema.parse(accepted.command).input
}

async function lockClaimableConversation(tx: Transaction<DB>) {
  // The conversation is the serialization authority, not a worker's in-memory queue.
  // SKIP LOCKED allows independent threads to progress without two claims on one thread.
  return await tx
    .selectFrom('execution.conversations as conversation')
    .select([
      'conversation.thread_id',
      'conversation.native_sandbox',
      'conversation.sandbox_recovery_required',
      'conversation.active_run_id',
    ])
    .where(
      sql<boolean>`
      conversation.lease_until <= clock_timestamp()
      or (
        conversation.active_run_id is null
        and exists (
          select 1 from execution.runs as queued
          where queued.thread_id = conversation.thread_id
            and queued.status = 'queued'
        )
      )
    `,
    )
    .orderBy('conversation.thread_id')
    .forUpdate()
    .skipLocked()
    .limit(1)
    .executeTakeFirst()
}

async function interruptRun(
  tx: Transaction<DB>,
  run: Readonly<{ threadID: string; runID: string }>,
) {
  // An expired worker may have submitted a paid external operation. Its outcome is unknown;
  // never return that run to queued or automatically submit inference again.
  await tx
    .updateTable('execution.runs')
    .set({ status: 'failed' })
    .where('run_id', '=', run.runID)
    .execute()
  await enqueueEvent(tx, {
    ...eventIdentities(run),
    kind: 'run-failed',
    reason: 'interrupted',
  })
  await releaseConversation(tx, run.threadID)
}

function leaseDeadline(leaseMs: number) {
  // Database time is authoritative; worker clock skew must not extend ownership.
  return sql<Date>`clock_timestamp() + ${leaseMs} * interval '1 millisecond'`
}

export async function lockLease(tx: Transaction<DB>, lease: ExecutionLease) {
  // All mutations authorize against the same locked record, including owner, run, fence and
  // expiration. Possession of an old lease object does not authorize history or public events.
  const conversation = await tx
    .selectFrom('execution.conversations')
    .select('thread_id')
    .where('thread_id', '=', lease.threadID)
    .where('active_run_id', '=', lease.runID)
    .where('lease_owner', '=', lease.ownerID)
    .where('fence', '=', lease.fence)
    .forUpdate()
    .executeTakeFirst()
  if (conversation === undefined) return undefined
  // PostgreSQL may evaluate WHERE before waiting for FOR UPDATE. Check expiration in
  // a fresh statement after acquiring authority, otherwise a blocked worker can outlive it.
  return await tx
    .selectFrom('execution.runs as run')
    .innerJoin(
      'execution.conversations as conversation',
      'conversation.active_run_id',
      'run.run_id',
    )
    .select([
      'run.cancel_requested',
      'run.assistant_message_id',
      'conversation.sandbox_recovery_required',
    ])
    .where('conversation.thread_id', '=', lease.threadID)
    .where('conversation.lease_until', '>', sql<Date>`clock_timestamp()`)
    .where('run.status', '=', 'running')
    .executeTakeFirst()
}

async function renewLease(
  tx: Transaction<DB>,
  lease: ExecutionLease,
  leaseMs: number,
) {
  const run = await lockLease(tx, lease)
  if (run === undefined) return 'lost' as const
  await tx
    .updateTable('execution.conversations')
    .set({ lease_until: leaseDeadline(leaseMs) })
    .where('thread_id', '=', lease.threadID)
    .execute()
  // Cancellation stops spending, but the current owner must retain its lease
  // until all abort/remote cleanup has settled.
  if (run.sandbox_recovery_required) return 'recovery-required' as const
  return run.cancel_requested ? ('cancel' as const) : ('renewed' as const)
}

export async function releaseConversation(
  tx: Transaction<DB>,
  threadID: string,
) {
  await tx
    .updateTable('execution.conversations')
    .set({ active_run_id: null, lease_owner: null, lease_until: null })
    .where('thread_id', '=', threadID)
    .execute()
}

/** Already accepted work must receive a durable explicit terminal, not sit queued. */
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
