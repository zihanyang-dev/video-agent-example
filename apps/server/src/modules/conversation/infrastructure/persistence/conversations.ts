import type { SQL } from 'bun'
import type { ExecutionCommand } from '@vid/contract/execution'
import type { Conversations } from '../../application/ports/conversations'
import type { Change, Message, Snapshot } from '../../domain/message'
import { appendChange } from './events'

/**
 * User messages, commands and public changes commit together. Returning acceptance
 * before any one of them is durable would make retries or a server restart lose work.
 */
export const createPostgresConversations = (sql: SQL): Conversations => ({
  open: async (thread) => {
    await sql`
      insert into product.threads (thread_id, user_id)
      values (${thread.threadID}, ${thread.userID})
    `
  },

  thread: async (threadID) => {
    const [thread] = await sql`
      select thread_id, user_id, active_turn_id
      from product.threads
      where thread_id = ${threadID}
    `

    return thread
      ? { threadID: thread.thread_id, userID: thread.user_id, activeTurnID: thread.active_turn_id }
      : null
  },

  accept: (input) => commitMessage(sql, input),

  stop: (input) =>
    sql.begin(async (tx) => {
      await enqueueCommand(tx, { kind: 'stop', ...input })
    }),

  snapshot: (threadID) => readSnapshot(sql, threadID),

  changes: async (cursor) => {
    const rows = await sql`
      select cursor::text, body
      from product.events
      where thread_id = ${cursor.threadID} and cursor > ${cursor.after}
      order by cursor
      limit 200
    `

    return rows.map((row: { cursor: string; body: Change }) => ({
      cursor: row.cursor,
      change: row.body,
    }))
  },
})

/** Serialize accepted messages per thread and commit their commands before acknowledging them. */
const commitMessage = (
  sql: SQL,
  input: Parameters<Conversations['accept']>[0],
): Promise<'accepted' | 'conflict'> =>
  sql.begin(async (tx) => {
    await tx`
      select thread_id
      from product.threads
      where thread_id = ${input.threadID}
      for update
    `

    const command: ExecutionCommand = { kind: 'message', ...input }
    const queued = await enqueueCommand(tx, command)
    if (queued === 'conflict') return 'conflict'
    if (queued === 'replay') return 'accepted'

    const message: Message = {
      id: `${input.commandID}:asked`,
      kind: 'text',
      author: 'user',
      text: input.message,
      finished: true,
    }
    await tx`
      insert into product.messages (thread_id, message_id, body)
      values (${input.threadID}, ${message.id}, ${message})
    `
    await appendChange(tx, input.threadID, { kind: 'message', message })

    return 'accepted'
  })

/** The cursor and messages must share a snapshot, or reconnect can skip a concurrent change. */
const readSnapshot = (sql: SQL, threadID: string): Promise<Snapshot> =>
  sql.begin('read only isolation level repeatable read', async (tx) => {
    const [thread] = await tx`
      select revision::text, active_turn_id
      from product.threads
      where thread_id = ${threadID}
    `
    const rows = await tx`
      select body
      from product.messages
      where thread_id = ${threadID}
      order by seq
    `

    return {
      messages: rows.map((row: { body: Message }) => row.body),
      cursor: thread.revision,
      activeTurnID: thread.active_turn_id,
    }
  })

/** The unique command ID arbitrates retries, including concurrent requests. */
const enqueueCommand = async (
  sql: SQL,
  command: ExecutionCommand,
): Promise<'new' | 'replay' | 'conflict'> => {
  const inserted = await sql`
    insert into product.outbox (command_id, body)
    values (${command.commandID}, ${command})
    on conflict do nothing
    returning command_id
  `
  if (inserted.length > 0) return 'new'

  const [same] = await sql`
    select command_id
    from product.outbox
    where command_id = ${command.commandID} and body = ${command}
  `
  return same ? 'replay' : 'conflict'
}
