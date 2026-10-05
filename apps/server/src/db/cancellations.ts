import { readActiveRuns, publicThread } from './conversations'
import { lockThread, threadUnavailable } from './thread-access'
import { authorizeCancellation } from '../conversation/submission'
import type { DB } from '@vid/database/types'
import type { CancelCommand } from '@vid/contract/execution'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { OwnedThread } from '../conversation/submission'

export type OwnedRun = OwnedThread & Readonly<{ runID: string }>
export type CancelRun = OwnedRun & Readonly<{ commandID: string }>

export async function hasAcceptedRun(
  db: Kysely<DB>,
  { ownerID, threadID, runID }: OwnedRun,
) {
  const row = await db
    .selectFrom('product.command_outbox')
    .innerJoin(
      'product.threads',
      'product.threads.thread_id',
      'product.command_outbox.thread_id',
    )
    .select('command_id')
    .where('product.threads.owner_id', '=', ownerID)
    .where('product.command_outbox.thread_id', '=', threadID)
    .where('run_id', '=', runID)
    .where(sql<string>`command ->> 'kind'`, '=', 'start')
    .where(sql<string>`command ->> 'threadID'`, '=', threadID)
    .where(sql<string>`command ->> 'runID'`, '=', runID)
    .executeTakeFirst()
  return row !== undefined
}

export async function cancelRun(
  db: Kysely<DB>,
  request: CancelRun,
): Promise<'accepted' | 'unavailable' | 'conflict'> {
  const { threadID, runID, commandID } = request
  const command: CancelCommand = {
    version: 1,
    kind: 'cancel',
    threadID,
    runID,
    commandID,
  }
  // Lock the thread before deciding ownership and accepted-start authority,
  // then write/replay the cancel command under that same lock. A preflight HTTP
  // lookup could authorize against stale ownership. Cancellation is an accepted
  // request, not an execution terminal; it must never create assistant messages.
  try {
    return await db.transaction().execute(async (tx) => {
      await lockThread(tx, request, 'cancel')
      if (
        authorizeCancellation(await hasAcceptedRun(tx, request)) ===
        'unavailable'
      )
        return 'unavailable'
      const inserted = await tx
        .insertInto('product.command_outbox')
        .values({
          command_id: command.commandID,
          thread_id: command.threadID,
          run_id: command.runID,
          message_id: null,
          command,
        })
        .onConflict((c) => c.doNothing())
        .returning('command_id')
        .executeTakeFirst()
      if (inserted) return 'accepted'
      return await replayCancellation(tx, request, command)
    })
  } catch (cause) {
    if (cause === threadUnavailable) return 'unavailable'
    throw cause
  }
}

async function replayCancellation(
  tx: Transaction<DB>,
  request: CancelRun,
  command: CancelCommand,
): Promise<'accepted' | 'unavailable' | 'conflict'> {
  // Global command IDs may collide with foreign history. Hide that fact
  // rather than returning an observable conflict from another user's run.
  const scope = await tx
    .selectFrom('product.command_outbox as command')
    .innerJoin(
      'product.threads as thread',
      'thread.thread_id',
      'command.thread_id',
    )
    .select('thread.owner_id')
    .where('command.command_id', '=', command.commandID)
    .executeTakeFirst()
  if (scope && scope.owner_id !== request.ownerID) return 'unavailable'
  const replay = await tx
    .selectFrom('product.command_outbox')
    .select('command_id')
    .where('command_id', '=', command.commandID)
    .where('thread_id', '=', command.threadID)
    .where('run_id', '=', command.runID)
    .where(sql<boolean>`command = ${JSON.stringify(command)}::jsonb`)
    .executeTakeFirst()
  return replay ? 'accepted' : 'conflict'
}

/** Archive and send serialize on the existing thread lock. Stops are requests,
 * not fake terminals; repeated archives do not generate duplicate requests. */
export async function archiveThread(db: Kysely<DB>, identity: OwnedThread) {
  return await db.transaction().execute(async (tx) => {
    const thread = await lockThread(tx, identity, 'read')
    if (thread.archived_at !== null) return publicThread(thread)
    const archived = await tx
      .updateTable('product.threads')
      .set({ archived_at: sql<Date>`clock_timestamp()` })
      .where('thread_id', '=', identity.threadID)
      .returningAll()
      .executeTakeFirstOrThrow()
    const runs = await readActiveRuns(tx, identity.threadID)
    for (const run of runs) {
      if (run.status === 'stopping') continue
      const command: CancelCommand = {
        version: 1,
        kind: 'cancel',
        threadID: identity.threadID,
        runID: run.runID,
        commandID: crypto.randomUUID(),
      }
      await tx
        .insertInto('product.command_outbox')
        .values({
          command_id: command.commandID,
          thread_id: command.threadID,
          run_id: command.runID,
          message_id: null,
          command,
        })
        .execute()
    }
    return publicThread(archived)
  })
}
