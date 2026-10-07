import type { DB } from '@vid/database/types'
import { executionCommandSchema, type ExecutionCommand } from '@vid/contract/execution'
import type { Kysely, Selectable } from 'kysely'

type CommandPublication = Readonly<{
  commandID: string
  // Resolve after transport acceptance, not after scheduling a send.
  publish: (command: ExecutionCommand) => Promise<void>
}>

type CommandBatch = Readonly<{
  limit: number
  publish: (command: ExecutionCommand) => Promise<void>
}>

// Each row commits independently. After a partial failure, retry retains the
// original identities and skips rows whose publication already committed.
export async function publishCommands(db: Kysely<DB>, batch: CommandBatch): Promise<number> {
  if (!Number.isSafeInteger(batch.limit) || batch.limit < 1) {
    throw new RangeError('Command batch limit must be a positive safe integer')
  }

  const pending = await db
    .selectFrom('product.command_outbox')
    .select('command_id')
    .where('published_at', 'is', null)
    .orderBy('created_at')
    .orderBy('command_id')
    .limit(batch.limit)
    .execute()

  let published = 0
  for (const row of pending) {
    const outcome = await publishCommand(db, {
      commandID: row.command_id,
      publish: batch.publish,
    })
    if (outcome === 'published') published += 1
  }
  return published
}

// The caller must bound this operation, including publication and database waits.
// Unknown delivery or database commit outcomes can duplicate delivery with the same IDs.
// "skipped" includes missing, already published, and currently locked rows.
export async function publishCommand(
  db: Kysely<DB>,
  publication: CommandPublication,
): Promise<'published' | 'skipped'> {
  // Open decision: publication deliberately holds the row lock across transport
  // acceptance. Moving network I/O outside SQL without a durable claim would
  // permit competing publishers to send this row. Keep this reliability contract
  // until a separately verified claim/receipt design replaces it. The supplied
  // callback is the actual adapter, bounded by its network timeout in bootstrap;
  // a lost receipt or uncertain commit retries the SAME identities, never new work.
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
