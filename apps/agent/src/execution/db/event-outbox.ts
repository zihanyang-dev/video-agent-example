import type { DB } from '@vid/database/types'
import { sql, type Transaction } from 'kysely'
import type { ExecutionEvent } from '@vid/contract/execution'

export function eventIdentities(run: Readonly<{ threadID: string; runID: string }>) {
  return {
    version: 1,
    eventID: crypto.randomUUID(),
    threadID: run.threadID.toLowerCase(),
    runID: run.runID.toLowerCase(),
  } as const
}

export async function enqueueEvent(tx: Transaction<DB>, event: ExecutionEvent) {
  // Conversation locking serializes ordinal allocation with terminal/history changes.
  const latest = await tx
    .selectFrom('execution.event_outbox')
    .select('ordinal')
    .where('run_id', '=', event.runID)
    .orderBy('ordinal', 'desc')
    .limit(1)
    .executeTakeFirst()
  const ordinal = latest === undefined ? 1 : latest.ordinal + 1
  await tx
    .insertInto('execution.event_outbox')
    .values({
      event_id: event.eventID,
      thread_id: event.threadID,
      run_id: event.runID,
      ordinal,
      event: sql`${JSON.stringify(event)}::jsonb`,
    })
    .execute()
}
