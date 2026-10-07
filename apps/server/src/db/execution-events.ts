import { assetBudgetDefaults } from '@vid/config'
import { acceptedStartIdentity } from './accepted-start'
import { validGeneratedAssets, type AssetLimits } from '../assets/files'
import { publicEvent } from '../conversation/execution-receipts'
import type { DB } from '@vid/database/types'
import {
  executionEventSchema,
  type ExecutionDelivery,
  type ExecutionEvent,
} from '@vid/contract/execution'
import { sql, type Kysely, type Transaction } from 'kysely'

type ReceiptOutcome = 'accepted' | 'unknown-run' | 'conflict'
const receiptConflict = new Error('Execution receipt conflict')

/** The transport validates deliveries; ordinals come from the execution outbox, not arrival order. */
export async function acceptExecutionEvent(
  db: Kysely<DB>,
  delivery: ExecutionDelivery,
  limits: AssetLimits = {
    maxBytes: assetBudgetDefaults.ASSET_MAX_BYTES,
    maxFiles: assetBudgetDefaults.ASSET_MAX_FILES,
  },
): Promise<ReceiptOutcome> {
  if (!Number.isSafeInteger(delivery.ordinal) || delivery.ordinal < 1) return 'conflict'
  const event = publicEvent(delivery.event)
  try {
    return await db
      .transaction()
      .execute((tx) => acceptReceipt(tx, { event, ordinal: delivery.ordinal }, limits))
  } catch (error) {
    if (error === receiptConflict) return 'conflict'
    throw error
  }
}

// Lock the thread before reading accepted-start authority and allocating cursors.
// Receipt, canonical assistant message and replay publication remain one commit;
// the transport may ACK only after this transaction returns. Unknown commit
// outcomes replay identical facts, rather than fabricating a new terminal.
async function acceptReceipt(
  tx: Transaction<DB>,
  { event, ordinal }: ExecutionDelivery,
  limits: AssetLimits,
): Promise<ReceiptOutcome> {
  if (!(await authorizedRun(tx, event))) return 'unknown-run'

  // Compare against a prior receipt, before this event could become the first
  // message-bearing ordinal. The partial index reads one identity, not its text.
  if ('messageID' in event) {
    const prior = await tx
      .selectFrom('product.execution_events')
      .select(sql<string>`payload ->> 'messageID'`.as('messageID'))
      .where('thread_id', '=', event.threadID)
      .where('run_id', '=', event.runID)
      .where(sql<boolean>`payload ? 'messageID'`)
      .orderBy('ordinal', 'asc')
      .limit(1)
      .executeTakeFirst()
    if (prior !== undefined && prior.messageID !== event.messageID) throw receiptConflict
  }

  const inserted = await tx
    .insertInto('product.execution_events')
    .values({
      event_id: event.eventID,
      thread_id: event.threadID,
      run_id: event.runID,
      ordinal: String(ordinal),
      payload: sql`${JSON.stringify(event)}::jsonb`,
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning('event_id')
    .executeTakeFirst()
  if (!inserted) {
    const same = await tx
      .selectFrom('product.execution_events')
      .select('event_id')
      .where('event_id', '=', event.eventID)
      .where('thread_id', '=', event.threadID)
      .where('run_id', '=', event.runID)
      .where('ordinal', '=', String(ordinal))
      .where(sql<boolean>`payload = ${JSON.stringify(event)}::jsonb`)
      .executeTakeFirst()
    if (!same) throw receiptConflict
    return 'accepted'
  }

  if (event.kind === 'run-completed' && !validGeneratedAssets(event, event.assets ?? [], limits))
    throw receiptConflict
  await storeFinalMessage(tx, event)
  await publishContiguousReceipts(tx, event)
  return 'accepted'
}

async function authorizedRun(tx: Transaction<DB>, event: ExecutionEvent): Promise<boolean> {
  // Serializes receipt effects AND cursor allocation through commit for this thread.
  const thread = await tx
    .selectFrom('product.threads')
    .select('thread_id')
    .where('thread_id', '=', event.threadID)
    .forUpdate()
    .executeTakeFirst()
  if (!thread) return false
  const start = await tx
    .selectFrom('product.command_outbox as start')
    .select('start.command_id')
    .where('start.thread_id', '=', event.threadID)
    .where('start.run_id', '=', event.runID)
    .where(acceptedStartIdentity())
    .executeTakeFirst()
  return start !== undefined
}

async function publishContiguousReceipts(
  tx: Transaction<DB>,
  event: ExecutionEvent,
): Promise<void> {
  // Existing processed receipts are the committed contiguous prefix; no second
  // watermark is persisted. Indexed successor lookups stop at the first gap.
  // A terminal is unique per run, including when it arrived before that gap.
  await sql`
    with recursive
      terminal as (
        select ordinal from product.execution_events
        where thread_id = ${event.threadID} and run_id = ${event.runID}
          and payload ->> 'kind' in ('run-completed', 'run-cancelled', 'run-failed')
      ),
      contiguous as (
        select event_id, ordinal, payload ->> 'kind' as kind
        from product.execution_events
        where thread_id = ${event.threadID} and run_id = ${event.runID}
          and ordinal = coalesce((
            select ordinal from product.execution_events
            where thread_id = ${event.threadID} and run_id = ${event.runID} and processed
            order by ordinal desc limit 1
          ), 0) + 1
        union all
        select next.event_id, next.ordinal, next.kind
        from contiguous as prior
        join lateral (
          select event_id, ordinal, payload ->> 'kind' as kind
          from product.execution_events
          where thread_id = ${event.threadID} and run_id = ${event.runID}
            and ordinal = prior.ordinal + 1
          limit 1
        ) as next on true
      ),
      publication as materialized (
        select event_id,
          case when exists (
            select 1 from terminal
            where contiguous.kind = 'assistant-text' or contiguous.ordinal > terminal.ordinal
          ) then null else nextval('product.execution_event_replay_cursor') end as cursor
        from contiguous order by ordinal
      )
    update product.execution_events as receipt
    set processed = true, replay_cursor = publication.cursor
    from publication where receipt.event_id = publication.event_id
  `.execute(tx)
}

async function storeFinalMessage(tx: Transaction<DB>, event: ExecutionEvent): Promise<void> {
  if (event.kind !== 'run-completed') return
  // Never adopt an existing message ID, even if its text happens to match.
  const message = await tx
    .insertInto('product.messages')
    .values({
      message_id: event.messageID,
      thread_id: event.threadID,
      role: 'assistant',
      text: event.text,
      sources: sql`${JSON.stringify(event.sources ?? [])}::jsonb`,
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning('message_id')
    .executeTakeFirst()
  if (!message) throw receiptConflict
  await storeAssets(tx, event)
}

/** Cursor scope is one owned thread. null means the thread is missing or not owned. */
export async function readPublicEvents(
  db: Kysely<DB>,
  query: Readonly<{
    ownerID: string
    threadID: string
    runID?: string
    after?: string
    limit?: number
  }>,
): Promise<Array<{
  cursor: string
  ordinal: number
  event: ExecutionEvent
}> | null> {
  const thread = await db
    .selectFrom('product.threads')
    .select('thread_id')
    .where('thread_id', '=', query.threadID)
    .where('product.threads.owner_id', '=', query.ownerID)
    .executeTakeFirst()
  if (!thread) return null
  const rows = await db
    .selectFrom('product.execution_events')
    .innerJoin('product.threads', 'product.threads.thread_id', 'product.execution_events.thread_id')
    .select(['payload', 'ordinal', 'replay_cursor'])
    .where('product.threads.owner_id', '=', query.ownerID)
    .where('product.execution_events.thread_id', '=', query.threadID)
    .$if(query.runID !== undefined, (qb) =>
      qb.where('product.execution_events.run_id', '=', query.runID!),
    )
    .where('replay_cursor', '>', query.after ?? '0')
    .orderBy('replay_cursor', 'asc')
    .limit(query.limit ?? 1000)
    .execute()
  return rows.map((row) => {
    if (row.replay_cursor === null) throw new Error('Missing published replay cursor')
    return {
      cursor: row.replay_cursor,
      ordinal: Number(row.ordinal),
      event: executionEventSchema.parse(row.payload),
    }
  })
}

async function storeAssets(
  tx: Transaction<DB>,
  event: Extract<ExecutionEvent, { kind: 'run-completed' }>,
) {
  for (const [position, asset] of (event.assets ?? []).entries()) {
    const inserted = await tx
      .insertInto('product.assets')
      .values({
        asset_id: asset.assetID,
        source: 'generated',
        ready_at: new Date(),
        thread_id: event.threadID,
        run_id: event.runID,
        message_id: event.messageID,
        name: asset.name,
        mime_type: asset.mimeType,
        byte_length: asset.byteLength,
        sha256: asset.sha256,
        object_key: asset.objectKey,
      })
      .onConflict((c) => c.doNothing())
      .returning('asset_id')
      .executeTakeFirst()
    if (!inserted) throw receiptConflict
    await tx
      .insertInto('product.message_assets')
      .values({
        thread_id: event.threadID,
        message_id: event.messageID,
        asset_id: asset.assetID,
        position,
      })
      .execute()
  }
}

/** A cursor names a durable publication for this thread, never a client offset. */
export async function hasPublicCursor(
  db: Kysely<DB>,
  query: Readonly<{ threadID: string; after: string }>,
) {
  if (query.after === '0') return true
  const fact = await db
    .selectFrom('product.execution_events')
    .select('event_id')
    .where('thread_id', '=', query.threadID)
    .where('replay_cursor', '=', query.after)
    .executeTakeFirst()
  return fact !== undefined
}
