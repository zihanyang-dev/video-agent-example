import type { DB } from '@vid/database/types'
import { sql, type Transaction } from 'kysely'
import type { ExecutionEvent } from '@vid/contract/execution'
import type { ExecutionOutcome } from '../../contract'
import { enqueueEvent } from './event-outbox'

export type TerminalEvent = Extract<
  ExecutionEvent,
  { kind: 'run-completed' | 'run-failed' | 'run-cancelled' }
>

/** Caller already holds conversation authority. One transaction records the
 * product terminal and public outbox; no native transcript is copied into SQL. */
export async function recordTerminal(
  tx: Transaction<DB>,
  event: TerminalEvent,
): Promise<Exclude<ExecutionOutcome, 'lost'>> {
  const status = {
    'run-completed': 'completed',
    'run-failed': 'failed',
    'run-cancelled': 'cancelled',
  } as const
  const outcome = status[event.kind]
  await tx
    .updateTable('execution.runs')
    .set({
      status: outcome,
      ...(event.kind === 'run-completed'
        ? {
            completion: sql`${JSON.stringify({
              text: event.text,
              ...(event.sources === undefined ? {} : { sources: event.sources }),
              ...(event.assets === undefined ? {} : { assets: event.assets }),
            })}::jsonb`,
          }
        : {}),
    })
    .where('run_id', '=', event.runID)
    .execute()
  await enqueueEvent(tx, event)
  await tx
    .updateTable('execution.conversations')
    .set({ active_run_id: null, lease_owner: null, lease_until: null })
    .where('thread_id', '=', event.threadID)
    .execute()
  return outcome
}
