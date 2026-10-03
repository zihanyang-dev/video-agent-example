import type { DB } from '@vid/database/types'
import {
  executionCommandSchema,
  type ExecutionCommand,
} from '@vid/execution-protocol'
import type { Kysely, Selectable } from 'kysely'

type CommandPublication = Readonly<{
  commandID: string
  // Resolve after transport acceptance, not after scheduling a send.
  publish: (command: ExecutionCommand) => Promise<void>
}>

// The caller must bound this operation, including publication and database waits.
// Unknown delivery or database commit outcomes can duplicate delivery with the same IDs.
// "skipped" includes missing, already published, and currently locked rows.
export async function publishCommand(
  db: Kysely<DB>,
  publication: CommandPublication,
): Promise<'published' | 'skipped'> {
  // Hold the row lock across the callback so competing publishers cannot send this row.
  return await db.transaction().execute(async (tx) => {
    const pending = await tx
      .selectFrom('product.command_outbox')
      .select(['command_id', 'thread_id', 'run_id', 'message_id', 'command'])
      .where('command_id', '=', publication.commandID)
      .where('published_at', 'is', null)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst()
    if (pending === undefined) return 'skipped'

    const command = storedCommand(pending)
    await publication.publish(command)

    await tx
      .updateTable('product.command_outbox')
      .set({ published_at: tx.fn<Date>('clock_timestamp', []) })
      .where('command_id', '=', pending.command_id)
      .execute()
    return 'published'
  })
}

type PendingCommand = Pick<
  Selectable<DB['product.command_outbox']>,
  'command_id' | 'thread_id' | 'run_id' | 'message_id' | 'command'
>

function storedCommand(pending: PendingCommand): ExecutionCommand {
  // JSON stored by another process/version is untyped; validate at this read boundary.
  const command = executionCommandSchema.parse(pending.command)
  // Valid wire fields must also agree with the indexed outbox headers we locked.
  const messageID = command.kind === 'start' ? command.input.messageID : null
  if (
    command.commandID !== pending.command_id ||
    command.threadID !== pending.thread_id ||
    command.runID !== pending.run_id ||
    messageID !== pending.message_id
  )
    throw new Error('Stored command identities do not match the outbox record')
  return command
}
