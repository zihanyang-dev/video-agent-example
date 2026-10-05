import type { DB } from '@vid/database/types'
import type { Transaction } from 'kysely'
import {
  decideThreadAccess,
  type OwnedThread,
} from '../conversation/submission'
export const threadUnavailable = new Error('Thread unavailable')
export const threadConflict = new Error('Thread conflict')
export const legacyOwnershipUnmapped = new Error(
  'Legacy thread ownership requires administrator assignment',
)

/** Every writer locks the same existing thread before checking ownership and
 * archive state. Missing and foreign IDs deliberately have identical recovery.
 * Reads may observe archived history; cancellation may still request a stop. */
export async function lockThread(
  tx: Transaction<DB>,
  query: OwnedThread,
  action: 'read' | 'write' | 'cancel',
) {
  const thread = await tx
    .selectFrom('product.threads')
    .selectAll()
    .where('thread_id', '=', query.threadID)
    .forUpdate()
    .executeTakeFirst()
  const access = decideThreadAccess(
    query.ownerID,
    thread
      ? { ownerID: thread.owner_id, archived: thread.archived_at !== null }
      : null,
    action,
  )
  if (access === 'unavailable') throw threadUnavailable
  if (access === 'conflict') throw threadConflict
  if (!thread) throw threadUnavailable
  return thread
}
