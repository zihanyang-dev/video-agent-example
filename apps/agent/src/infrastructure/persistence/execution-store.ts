import type { SQL } from 'bun'
import type { ExecutionStore } from '../../application/ports/execution-store'
import type { Progress } from '../../domain/progress'
import type { Checkpoint, Controls, Run } from '../../domain/run'
import { acceptInput, acceptStop } from './inputs'
import { claimRun, expireRuns } from './claim'
import { appendProgress, requireLease } from './progress'

/**
 * Transactions touching both records lock the session before the run, matching claim
 * and expiry. Reversing that order in one path can deadlock with cancellation or sealing.
 */
export const createPostgresExecutionStore = (sql: SQL, leaseMs: number): ExecutionStore => ({
  accept: (input) => acceptInput(sql, input),
  stop: (input) => acceptStop(sql, input),
  claim: (owner) => claimRun(sql, owner, leaseMs),
  renew: (run) => renewLease(sql, run, leaseMs),
  controls: (run) => readControls(sql, run),
  delivered: async (commandID) => {
    await sql`
      update execution.inputs
      set delivered = true
      where command_id = ${commandID}
    `
  },
  seal: (run) => sealRun(sql, run),
  checkpoint: (threadID) => readCheckpoint(sql, threadID),
  append: (run, progress) => appendOwnedProgress(sql, run, progress),
  complete: (run, completion) => commitCompletion(sql, run, completion),
  expire: () => expireRuns(sql),
})

const renewLease = async (sql: SQL, run: Run, leaseMs: number): Promise<boolean> => {
  const renewed = await sql`
    update execution.runs
    set lease_until = now() + ${leaseMs} * interval '1 millisecond'
    where turn_id = ${run.turnID}
      and owner = ${run.owner}
      and state = 'running'
      and lease_until > now()
    returning turn_id
  `
  return renewed.length > 0
}

const readControls = async (sql: SQL, run: Run): Promise<Controls> => {
  const [active] = await sql`
    select cancelled
    from execution.runs
    where turn_id = ${run.turnID} and owner = ${run.owner}
  `
  const messages = await sql`
    select command_id, thread_id, message
    from execution.inputs
    where turn_id = ${run.turnID} and not delivered
    order by ordinal
  `

  return {
    cancelled: active.cancelled,
    messages: messages.map((input: { command_id: string; thread_id: string; message: string }) => ({
      commandID: input.command_id,
      threadID: input.thread_id,
      message: input.message,
    })),
  }
}

const sealRun = (sql: SQL, run: Run): Promise<void> =>
  sql.begin(async (transaction) => {
    await transaction`
      select thread_id
      from execution.sessions
      where thread_id = ${run.threadID}
      for update
    `
    await requireLease(transaction, run)

    await transaction`
      update execution.runs
      set accepting = false
      where turn_id = ${run.turnID}
    `
    await transaction`
      update execution.inputs
      set turn_id = null
      where turn_id = ${run.turnID} and not delivered
    `
  })

const readCheckpoint = async (sql: SQL, threadID: string): Promise<Checkpoint> => {
  const [session] = await sql`
    select entries, workspace
    from execution.sessions
    where thread_id = ${threadID}
  `
  return {
    entries: session.entries as readonly unknown[],
    workspace: session.workspace as string | null,
  }
}

const appendOwnedProgress = (sql: SQL, run: Run, progress: Progress): Promise<void> =>
  sql.begin(async (transaction) => {
    await transaction`
      select thread_id
      from execution.sessions
      where thread_id = ${run.threadID}
      for update
    `
    await requireLease(transaction, run)

    await appendProgress(transaction, run, progress)
  })

/**
 * The finished event must not become visible without its checkpoint. Keep it in this
 * transaction so replay cannot announce success for history or files we failed to commit.
 */
const commitCompletion = (
  sql: SQL,
  run: Run,
  completion: Parameters<ExecutionStore['complete']>[1],
): Promise<void> =>
  sql.begin(async (transaction) => {
    await transaction`
      select thread_id
      from execution.sessions
      where thread_id = ${run.threadID}
      for update
    `
    await requireLease(transaction, run)

    await transaction`
      update execution.inputs
      set turn_id = null
      where turn_id = ${run.turnID} and not delivered
    `
    await transaction`
      update execution.sessions
      set entries = ${completion.checkpoint.entries},
          workspace = ${completion.checkpoint.workspace},
          active_turn_id = null,
          updated_at = now()
      where thread_id = ${run.threadID}
    `
    await transaction`
      update execution.runs
      set state = ${completion.outcome}, accepting = false
      where turn_id = ${run.turnID}
    `

    await appendProgress(transaction, run, {
      kind: 'finished',
      outcome: completion.outcome,
      reason: completion.reason,
    })
  })
