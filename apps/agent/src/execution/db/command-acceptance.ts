import type { DB } from '@vid/database/types'
import {
  executionCommandSchema,
  type ExecutionCommand,
  type StartCommand,
  type CancelCommand,
} from '@vid/contract/execution'
import { sql, type Kysely, type Transaction } from 'kysely'
import { enqueueEvent, eventIdentities } from './event-outbox'

const commandConflict = new Error('Execution command conflicts with accepted identity')

/** Inbox acceptance and cancellation share conversation authority with claims.
 * Lock order is inbox identity, then conversation, then run mutation. This also
 * serializes pre-start cancellation with a later start on the same thread.
 * A conflict rolls back the inbox insert too; ACK is allowed only after commit.
 */
export async function acceptExecutionCommand(db: Kysely<DB>, input: ExecutionCommand) {
  const command = executionCommandSchema.parse(input)
  try {
    return await db.transaction().execute((tx) => acceptCommand(tx, command))
  } catch (error) {
    if (error === commandConflict) return 'conflict' as const
    throw error
  }
}

async function acceptCommand(tx: Transaction<DB>, command: ExecutionCommand) {
  // Retain canonical commands even after publication and termination: deleting inbox rows would erase both replay and pre-start cancellation.
  const inserted = await tx
    .insertInto('execution.command_inbox')
    .values({
      command_id: command.commandID,
      thread_id: command.threadID,
      run_id: command.runID,
      kind: command.kind,
      command: sql`${JSON.stringify(command)}::jsonb`,
    })
    // The composite FK target is also unique. Concurrent exact deliveries can
    // conflict through either index; replay below still checks the full body.
    .onConflict((conflict) => conflict.doNothing())
    .returning('command_id')
    .executeTakeFirst()
  if (inserted === undefined) return await replayCommand(tx, command)

  await tx
    .insertInto('execution.conversations')
    .values({ thread_id: command.threadID })
    .onConflict((conflict) => conflict.column('thread_id').doNothing())
    .execute()
  await tx
    .selectFrom('execution.conversations')
    .select('thread_id')
    .where('thread_id', '=', command.threadID)
    .forUpdate()
    .executeTakeFirstOrThrow()

  const existing = await tx
    .selectFrom('execution.runs')
    .select('thread_id')
    .where('run_id', '=', command.runID)
    .executeTakeFirst()
  if (
    existing !== undefined &&
    (existing.thread_id !== command.threadID || command.kind === 'start')
  )
    throw commandConflict
  if (command.kind === 'start') await acceptStart(tx, command)
  if (command.kind === 'cancel') await acceptCancel(tx, command)
  return 'accepted' as const
}

async function replayCommand(tx: Transaction<DB>, command: ExecutionCommand) {
  // Read Committed sees the winning insert after ON CONFLICT has waited for it.
  const replay = await tx
    .selectFrom('execution.command_inbox')
    .select('command')
    .where('command_id', '=', command.commandID)
    .executeTakeFirst()
  if (replay === undefined) {
    return 'conflict' as const
  }
  // Normalize legacy JSON as well as new deliveries; schema parsing fixes key order.
  const stored = executionCommandSchema.safeParse(replay.command)
  if (!stored.success) {
    return 'conflict' as const
  }
  if (JSON.stringify(stored.data) !== JSON.stringify(command)) {
    return 'conflict' as const
  }
  return 'replay' as const
}

async function acceptStart(tx: Transaction<DB>, command: StartCommand) {
  const cancellation = await tx
    .selectFrom('execution.command_inbox')
    .select('command_id')
    .where('run_id', '=', command.runID)
    .where('thread_id', '=', command.threadID)
    .where('kind', '=', 'cancel')
    .executeTakeFirst()
  const isCancelled = cancellation !== undefined
  const inserted = await tx
    .insertInto('execution.runs')
    .values({
      run_id: command.runID,
      thread_id: command.threadID,
      command_id: command.commandID,
      message_id: command.input.messageID,
      text: command.input.text,
      status: isCancelled ? 'cancelled' : 'queued',
      cancel_requested: isCancelled,
    })
    .onConflict((conflict) => conflict.column('run_id').doNothing())
    .returning('run_id')
    .executeTakeFirst()
  if (inserted === undefined) throw commandConflict
  if (isCancelled)
    await enqueueEvent(tx, {
      ...eventIdentities(command),
      kind: 'run-cancelled',
    })
}

async function acceptCancel(tx: Transaction<DB>, command: CancelCommand) {
  const run = await tx
    .updateTable('execution.runs')
    .set({ cancel_requested: true })
    .where('run_id', '=', command.runID)
    .where('thread_id', '=', command.threadID)
    .where('status', 'in', ['queued', 'running'])
    .returning('status')
    .executeTakeFirst()
  if (run?.status !== 'queued') return
  await tx
    .updateTable('execution.runs')
    .set({ status: 'cancelled' })
    .where('run_id', '=', command.runID)
    .execute()
  await enqueueEvent(tx, { ...eventIdentities(command), kind: 'run-cancelled' })
}
