import type { DB } from '@vid/database/types'
import {
  executionDeliverySchema,
  type ExecutionDelivery,
} from '@vid/contract/execution'
import type { Kysely, Transaction } from 'kysely'

type Publication = Readonly<{
  eventID: string
  publish: (delivery: ExecutionDelivery) => Promise<void>
}>

/** The caller awaits official Redis xAdd acceptance and bounds transport/DB waits.
 * The row lock remains held across publish and the publication timestamp, so
 * concurrent publishers cannot both claim successful sends. Moving the network
 * call outside this transaction would require a durable publication claim.
 * An unknown send or commit outcome may duplicate the same event and ordinal;
 * receiver replay by eventID is still required, not exactly-once delivery.
 */
export async function publishEvent(
  db: Kysely<DB>,
  publication: Publication,
): Promise<'published' | 'skipped'> {
  return await db
    .transaction()
    .execute((tx) => publishLockedEvent(tx, publication))
}

async function publishLockedEvent(
  tx: Transaction<DB>,
  publication: Publication,
): Promise<'published' | 'skipped'> {
  const pending = await lockUnpublishedEvent(tx, publication.eventID)
  if (pending === undefined) return 'skipped'

  const delivery = decodeStoredDelivery(pending)
  await publication.publish(delivery)
  await tx
    .updateTable('execution.event_outbox')
    .set({ published_at: tx.fn<Date>('clock_timestamp', []) })
    .where('event_id', '=', pending.event_id)
    .execute()
  return 'published'
}

async function lockUnpublishedEvent(tx: Transaction<DB>, eventID: string) {
  return await tx
    .selectFrom('execution.event_outbox')
    .select(['event_id', 'thread_id', 'run_id', 'ordinal', 'event'])
    .where('event_id', '=', eventID)
    .where('published_at', 'is', null)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst()
}

function decodeStoredDelivery(
  pending: NonNullable<Awaited<ReturnType<typeof lockUnpublishedEvent>>>,
) {
  const delivery = executionDeliverySchema.parse({
    ordinal: pending.ordinal,
    event: pending.event,
  })
  if (
    delivery.event.eventID !== pending.event_id ||
    delivery.event.threadID !== pending.thread_id ||
    delivery.event.runID !== pending.run_id
  )
    throw new Error('Stored event identities do not match the outbox record')

  return delivery
}

/** A polling hint, not a claim: publishEvent rechecks under its row lock. */
export async function pendingEventIDs(db: Kysely<DB>) {
  return await db
    .selectFrom('execution.event_outbox')
    .select('event_id')
    .where('published_at', 'is', null)
    .orderBy('run_id')
    .orderBy('ordinal')
    .limit(32)
    .execute()
}
