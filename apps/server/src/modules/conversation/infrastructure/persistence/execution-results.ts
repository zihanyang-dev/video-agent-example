import type { SQL } from 'bun'
import type { ExecutionResults } from '../../application/ports/execution-results'
import { updateMessage, settleMessage, type ExecutionResult } from '../../domain/execution-result'
import type { Message } from '../../domain/message'
import { appendChange } from './events'

/**
 * Receipt, projection and public event advance atomically. Returning false leaves a
 * sequence gap pending for redelivery; acknowledging it would permanently drop progress.
 */
export const createPostgresExecutionResults = (sql: SQL): ExecutionResults => ({
  apply: (execution) =>
    sql.begin(async (tx) => {
      await tx`
        select thread_id
        from product.threads
        where thread_id = ${execution.threadID}
        for update
      `

      const [seen] = await tx`
        select event_id
        from product.execution_receipts
        where event_id = ${execution.eventID}
      `
      if (seen) return true

      await tx`
        insert into product.execution_views (thread_id)
        values (${execution.threadID})
        on conflict do nothing
      `
      const [view] = await tx`
        select sequence
        from product.execution_views
        where thread_id = ${execution.threadID}
        for update
      `
      if (Number(view.sequence) + 1 !== execution.sequence) return false

      await projectExecutionResult(tx, execution)
      await tx`
        insert into product.execution_receipts (event_id, thread_id, sequence)
        values (${execution.eventID}, ${execution.threadID}, ${execution.sequence})
      `
      await tx`
        update product.execution_views
        set sequence = ${execution.sequence}
        where thread_id = ${execution.threadID}
      `

      return true
    }),
})

const projectExecutionResult = async (sql: SQL, execution: ExecutionResult): Promise<void> => {
  const update = execution.update

  if (update.kind === 'started') {
    await sql`
      update product.threads
      set active_turn_id = ${execution.turnID}
      where thread_id = ${execution.threadID}
    `
    await appendChange(sql, execution.threadID, { kind: 'started', turnID: execution.turnID })
    return
  }

  if (update.kind === 'finished') {
    await finishConversationTurn(sql, execution, update)
    return
  }

  const [stored] = await sql`
    select body
    from product.messages
    where thread_id = ${execution.threadID} and message_id = ${update.messageID}
  `
  const message = updateMessage(stored ? (stored.body as Message) : null, update)
  await sql`
    insert into product.messages (thread_id, message_id, body)
    values (${execution.threadID}, ${message.id}, ${message})
    on conflict (thread_id, message_id) do update set body = excluded.body
  `

  if (update.kind === 'activity') {
    await appendChange(sql, execution.threadID, { kind: 'message', message })
    return
  }

  await appendChange(sql, execution.threadID, {
    kind: 'text',
    phase: update.kind === 'text-start' ? 'start' : update.kind === 'text-end' ? 'end' : 'delta',
    messageID: update.messageID,
    author: update.channel,
    delta: update.kind === 'text-delta' ? update.delta : '',
  })
}

/**
 * Settle public messages before emitting the terminal change, so refresh and streaming
 * readers agree that no text or step is still running. Internal event logs retain reasoning.
 */
const finishConversationTurn = async (
  sql: SQL,
  execution: ExecutionResult,
  update: Extract<ExecutionResult['update'], { kind: 'finished' }>,
): Promise<void> => {
  await sql`
    update product.threads
    set active_turn_id = null
    where thread_id = ${execution.threadID} and active_turn_id = ${execution.turnID}
  `
  await sql`
    delete from product.messages
    where thread_id = ${execution.threadID} and body->>'author' = 'reasoning'
  `

  await settleMessages(sql, execution.threadID)
  await appendChange(sql, execution.threadID, { ...update, turnID: execution.turnID })
}

const settleMessages = async (sql: SQL, threadID: string): Promise<void> => {
  const unfinished = await sql`
    select body
    from product.messages
    where thread_id = ${threadID}
      and (body->>'finished' = 'false' or body->'activity'->>'state' = 'running')
  `

  for (const row of unfinished) {
    const message = settleMessage(row.body as Message)
    await sql`
      update product.messages
      set body = ${message}
      where thread_id = ${threadID} and message_id = ${message.id}
    `
    await appendChange(sql, threadID, { kind: 'message', message })
  }
}
