import type { DB } from '@vid/database/types'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { ExecutionEvent } from '@vid/contract/execution'
import type {
  ExecutionLease,
  ExecutionWrites,
  ExecutionCompletion,
  ExecutionFailure,
  ExecutionOutcome,
} from '../contract'
import type { NativeSandboxReference } from '../../sandbox/reference'
import {
  lockLease,
  releaseConversation,
  renewExecutionLease,
  historyByteLimit,
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
    complete: async (lease, completion) =>
      terminalOutcome(await completeExecutionRun(db, lease, completion), 'completed'),
    fail: async (lease, reason) =>
      terminalOutcome(await failExecutionRun(db, lease, reason), 'failed'),
    cancel: async (lease) => terminalOutcome(await cancelExecutionRun(db, lease), 'cancelled'),
  }
}

function terminalOutcome(
  accepted: boolean | ExecutionOutcome,
  requested: ExecutionOutcome,
): ExecutionOutcome {
  if (typeof accepted === 'string') return accepted
  return accepted ? requested : 'lost'
}

export async function appendExecutionText(db: Kysely<DB>, lease: ExecutionLease, text: string) {
  return await db.transaction().execute((tx) => appendText(tx, lease, text))
}

export async function completeExecutionRun(
  db: Kysely<DB>,
  lease: ExecutionLease,
  completion: ExecutionCompletion,
) {
  return await db.transaction().execute((tx) => finishRun(tx, lease, { completion }))
}

export async function failExecutionRun(
  db: Kysely<DB>,
  lease: ExecutionLease,
  reason: ExecutionFailure,
) {
  return await db.transaction().execute((tx) =>
    finishRun(tx, lease, {
      event: {
        ...eventIdentities(lease),
        kind: 'run-failed',
        reason,
      },
    }),
  )
}

export async function cancelExecutionRun(db: Kysely<DB>, lease: ExecutionLease) {
  const result = await db.transaction().execute((tx) =>
    finishRun(tx, lease, {
      event: { ...eventIdentities(lease), kind: 'run-cancelled' },
    }),
  )
  return result === 'cancelled' ? true : result
}

async function appendText(tx: Transaction<DB>, lease: ExecutionLease, delta: string) {
  const run = await lockLease(tx, lease)
  if (run === undefined || run.cancel_requested || run.sandbox_recovery_required) {
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

async function finishRun(
  tx: Transaction<DB>,
  lease: ExecutionLease,
  decision:
    | { completion: ExecutionCompletion }
    | {
        event: Extract<ExecutionEvent, { kind: 'run-failed' | 'run-cancelled' }>
      },
) {
  // One locked decision owns cancellation, terminal state, history and outbox.
  // lockLease checks owner/run/fence and post-lock database time.
  const run = await lockLease(tx, lease)
  if (run === undefined) return false
  const failure =
    'event' in decision &&
    decision.event.kind === 'run-failed' &&
    decision.event.reason === 'execution-error'
  if (run.sandbox_recovery_required && !failure) return false
  if (run.cancel_requested && !failure) {
    await recordTerminal(tx, {
      ...eventIdentities(lease),
      kind: 'run-cancelled',
    })
    return 'cancelled' as const
  }
  if ('event' in decision) {
    await recordTerminal(tx, decision.event)
    return true
  }
  return await persistCompletion(tx, lease, decision.completion, run.assistant_message_id!)
}

async function persistCompletion(
  tx: Transaction<DB>,
  lease: ExecutionLease,
  input: ExecutionCompletion,
  messageID: string,
) {
  // Keep history private and unchanged if it exceeds the reasonable input limit.
  const stored = await tx
    .with('completed_history', (query) =>
      query.selectNoFrom(sql`${JSON.stringify(input.history)}::jsonb`.as('value')),
    )
    .updateTable('execution.conversations')
    .from('completed_history')
    .set({ history: sql`completed_history.value` })
    .where('thread_id', '=', lease.threadID)
    .where(sql<boolean>`octet_length(completed_history.value::text) <= ${historyByteLimit}`)
    .returning('thread_id')
    .executeTakeFirst()
  if (stored === undefined) {
    await recordTerminal(tx, {
      ...eventIdentities(lease),
      kind: 'run-failed',
      reason: 'execution-error',
    })
    return 'failed' as const
  }
  await recordTerminal(tx, {
    ...eventIdentities(lease),
    kind: 'run-completed',
    messageID,
    text: input.text,
    ...(input.sources === undefined ? {} : { sources: input.sources }),
    ...(input.assets === undefined ? {} : { assets: [...input.assets] }),
  })
  return true
}

async function recordTerminal(
  tx: Transaction<DB>,
  event: Extract<ExecutionEvent, { kind: 'run-completed' | 'run-failed' | 'run-cancelled' }>,
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
    if (conversation.active_run_id !== lease.runID || conversation.fence !== lease.fence) return
    await recordTerminal(tx, {
      ...eventIdentities(lease),
      kind: 'run-failed',
      reason,
    })
  })
}
