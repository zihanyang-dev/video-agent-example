import type { SQL } from 'bun'
import type { Progress } from '../../domain/progress'
import type { Run } from '../../domain/run'
import type { ExecutionEvent } from '@vid/contract/execution'

// Called in the transaction that owns the session lock. Sequence is per thread, not
// per run, so a delayed terminal event cannot overtake the next run's start.
export const appendProgress = async (
  sql: SQL,
  run: Pick<Run, 'turnID' | 'threadID'>,
  progress: Progress,
): Promise<void> => {
  const [session] = await sql`
    update execution.sessions
    set event_sequence = event_sequence + 1
    where thread_id = ${run.threadID}
    returning event_sequence
  `

  const event: ExecutionEvent = {
    eventID: crypto.randomUUID(),
    threadID: run.threadID,
    turnID: run.turnID,
    sequence: Number(session.event_sequence),
    progress,
  }

  await sql`
    insert into execution.outbox (event_id, body)
    values (${event.eventID}, ${event})
  `
}

// Check under the write lock; a previously successful renewal cannot fence a stale writer.
export const requireLease = async (sql: SQL, run: Run): Promise<void> => {
  const [owned] = await sql`
    select turn_id
    from execution.runs
    where turn_id = ${run.turnID}
      and owner = ${run.owner}
      and state = 'running'
      and lease_until > now()
    for update
  `
  if (!owned) throw new Error(`execution lease lost for ${run.turnID}`)
}
