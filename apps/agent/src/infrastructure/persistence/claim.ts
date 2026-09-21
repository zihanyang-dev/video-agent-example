import type { SQL } from 'bun'
import type { Run } from '../../domain/run'
import { appendProgress } from './progress'

// The session lock serializes runs for one thread across workers. SKIP LOCKED lets
// other threads proceed without turning a busy conversation into a global queue lock.
export const claimRun = (sql: SQL, owner: string, leaseMs: number): Promise<Run | null> =>
  sql.begin(async (transaction) => {
    const [session] = await transaction`
      select session.thread_id
      from execution.sessions session
      where session.active_turn_id is null
        and exists (
          select 1 from execution.inputs input
          where input.thread_id = session.thread_id and input.turn_id is null
        )
      order by session.thread_id
      for update skip locked
      limit 1
    `
    if (!session) return null

    const [input] = await transaction`
      select command_id, message
      from execution.inputs
      where thread_id = ${session.thread_id} and turn_id is null
      order by ordinal
      limit 1
    `

    const run: Run = {
      threadID: session.thread_id,
      turnID: input.command_id,
      message: input.message,
      owner,
    }

    await transaction`
      insert into execution.runs (turn_id, thread_id, owner, state, lease_until)
      values (${run.turnID}, ${run.threadID}, ${owner}, 'running', now() + ${leaseMs} * interval '1 millisecond')
    `
    await transaction`
      update execution.sessions
      set active_turn_id = ${run.turnID}
      where thread_id = ${run.threadID}
    `
    await transaction`
      update execution.inputs
      set turn_id = ${run.turnID}, delivered = true
      where command_id = ${input.command_id}
    `

    await appendProgress(transaction, run, { kind: 'started' })
    return run
  })

export const expireRuns = (sql: SQL): Promise<void> =>
  sql.begin(async (transaction) => {
    const expired = await transaction`
      select session.thread_id, session.active_turn_id
      from execution.sessions session
      join execution.runs run on run.turn_id = session.active_turn_id
      where run.state = 'running' and run.lease_until <= now()
      for update of session skip locked
    `
    for (const session of expired) await interruptExpired(transaction, session)
  })

// Renewal can race the expiry scan, so the update rechecks the deadline. Work with
// recorded delivery intent may have external effects; only untouched inputs are requeued.
const interruptExpired = async (
  sql: SQL,
  session: { thread_id: string; active_turn_id: string },
): Promise<void> => {
  const changed = await sql`
    update execution.runs
    set state = 'interrupted', accepting = false
    where turn_id = ${session.active_turn_id} and lease_until <= now() and state = 'running'
    returning turn_id
  `
  if (changed.length === 0) return

  await sql`
    update execution.inputs
    set turn_id = null
    where turn_id = ${session.active_turn_id} and not delivered
  `
  await sql`
    update execution.sessions
    set active_turn_id = null
    where thread_id = ${session.thread_id}
  `
  await appendProgress(
    sql,
    { threadID: session.thread_id, turnID: session.active_turn_id },
    { kind: 'finished', outcome: 'interrupted', reason: 'execution lease expired' },
  )
}
