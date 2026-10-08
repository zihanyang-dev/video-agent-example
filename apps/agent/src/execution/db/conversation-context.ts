import type { DB } from '@vid/database/types'
import { sql, type Kysely } from 'kysely'
import {
  conversationContextSchema,
  CONVERSATION_CONTEXT_MAX_BYTES,
  type ConversationContext,
} from '@vid/contract/conversation-context'
import { completedEventSchema, startCommandSchema } from '@vid/contract/execution'

const completionSchema = completedEventSchema.unwrap().omit({
  version: true,
  kind: true,
  eventID: true,
  threadID: true,
  runID: true,
  messageID: true,
})

/** Read before admission locks; the caller revalidates the source fence before
 * binding this snapshot. Completed facts do not settle native effects. */
export async function buildConversationContext(
  db: Kysely<DB>,
  threadID: string,
): Promise<ConversationContext> {
  const completed = db
    .selectFrom('execution.runs as r')
    .leftJoin('execution.command_inbox as c', 'c.command_id', 'r.command_id')
    .where('r.thread_id', '=', threadID)
    .where('r.status', '=', 'completed')
  const size = await completed
    .select(
      sql<string>`coalesce(sum(
      octet_length(r.text) + octet_length(coalesce(r.completion::text, 'null'))
      + octet_length(coalesce(c.command::text, 'null'))
    ), 0)::text`.as('bytes'),
    )
    .executeTakeFirstOrThrow()
  // SQL input includes the command envelope and a second copy of input text.
  // Bound that read too; the canonical context still has its exact 1 MiB limit.
  if (Number(size.bytes) > 3 * CONVERSATION_CONTEXT_MAX_BYTES)
    throw new Error('Conversation context exceeds UTF8 material limit')

  const rows = await completed
    .select([
      'r.run_id',
      'r.thread_id',
      'r.command_id',
      'r.message_id',
      'r.text',
      'r.assistant_message_id',
      'r.completion',
      'c.command',
      'c.kind',
    ])
    .orderBy('r.created_at')
    .orderBy('r.run_id')
    .execute()

  const turns = rows.map((row) => {
    const command = startCommandSchema.parse(row.command)
    if (
      row.kind !== 'start' ||
      command.commandID !== row.command_id ||
      command.threadID !== row.thread_id ||
      command.runID !== row.run_id ||
      command.input.messageID !== row.message_id ||
      command.input.text !== row.text
    )
      throw new Error('Completed run input conflicts with accepted identity')
    if (row.completion === null || row.assistant_message_id === null)
      throw new Error('Completed run is missing its final completion')

    const completion = completionSchema.parse(row.completion)
    return {
      runID: row.run_id,
      input: command.input,
      output: { messageID: row.assistant_message_id, ...completion },
    }
  })

  return conversationContextSchema.parse({
    version: 1,
    throughRunID: turns.at(-1)?.runID ?? null,
    turns,
  })
}
