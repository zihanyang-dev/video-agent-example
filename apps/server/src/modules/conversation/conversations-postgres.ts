import type { DB } from '@vid/database/types'
import type { StartCommand } from '@vid/execution-protocol'
import type { Kysely, Transaction } from 'kysely'
import type {
  ConversationWrites,
  MessageIntent,
  SubmitIntentOutcome,
} from './submit-message'

// Throwing inside Kysely's callback rolls back the message when its command cannot be committed.
const commandCollision = new Error('Pending command identity collision')

export function createConversationWrites(db: Kysely<DB>): ConversationWrites {
  return {
    submit: async (intent) => {
      try {
        return await db.transaction().execute((tx) => acceptMessage(tx, intent))
      } catch (error) {
        if (error === commandCollision) return { kind: 'conflict' }
        throw error
      }
    },
  }
}

async function acceptMessage(
  tx: Transaction<DB>,
  intent: MessageIntent,
): Promise<SubmitIntentOutcome> {
  // Lock the authorized thread so concurrent ownership changes cannot invalidate acceptance.
  const thread = await tx
    .selectFrom('product.threads')
    .select('thread_id')
    .where('thread_id', '=', intent.threadID)
    .where('owner_id', '=', intent.ownerID)
    .forUpdate()
    .executeTakeFirst()
  if (thread === undefined) return { kind: 'unavailable' }

  const replay = await acceptedMessage(tx, intent)
  if (replay !== null) return replay

  const message = await tx
    .insertInto('product.messages')
    .values({
      message_id: intent.messageID,
      thread_id: intent.threadID,
      role: 'user',
      text: intent.text,
    })
    .onConflict((conflict) => conflict.column('message_id').doNothing())
    .returning('message_id')
    .executeTakeFirst()
  if (message === undefined) {
    // Message IDs are global, so another thread can win after the first replay query.
    // Read Committed gives this query a fresh snapshot after the conflicting insert waits.
    const concurrentReplay = await acceptedMessage(tx, intent)
    if (concurrentReplay !== null) return concurrentReplay
    return { kind: 'conflict' }
  }

  await enqueueMessage(tx, intent)
  return {
    kind: 'accepted',
    messageID: intent.messageID,
    commandID: intent.commandID,
    runID: intent.runID,
  }
}

async function acceptedMessage(
  tx: Transaction<DB>,
  intent: MessageIntent,
): Promise<SubmitIntentOutcome | null> {
  // Published outbox rows still supply replay IDs; purging them would break identical retries.
  const message = await tx
    .selectFrom('product.messages as message')
    .leftJoin(
      'product.command_outbox as command',
      'command.message_id',
      'message.message_id',
    )
    .select([
      'message.thread_id',
      'message.role',
      'message.text',
      'command.command_id',
      'command.run_id',
    ])
    .where('message.message_id', '=', intent.messageID)
    .executeTakeFirst()
  if (message === undefined) return null
  if (
    message.thread_id !== intent.threadID ||
    message.text !== intent.text ||
    message.role !== 'user'
  )
    return { kind: 'conflict' }
  if (message.command_id === null || message.run_id === null)
    return { kind: 'conflict' }

  return {
    kind: 'accepted',
    messageID: intent.messageID,
    commandID: message.command_id,
    runID: message.run_id,
  }
}

async function enqueueMessage(
  tx: Transaction<DB>,
  intent: MessageIntent,
): Promise<void> {
  // This typed construction needs no runtime parse; stored JSON is parsed when read.
  const command = {
    version: 1,
    kind: 'start',
    commandID: intent.commandID,
    threadID: intent.threadID,
    runID: intent.runID,
    input: { messageID: intent.messageID, text: intent.text },
  } satisfies StartCommand
  const pending = await tx
    .insertInto('product.command_outbox')
    .values({
      command_id: intent.commandID,
      thread_id: intent.threadID,
      run_id: intent.runID,
      message_id: intent.messageID,
      command,
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning('command_id')
    .executeTakeFirst()
  if (pending === undefined) throw commandCollision
}
