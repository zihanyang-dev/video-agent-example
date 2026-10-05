import { assetBudgetDefaults } from '@vid/config'
import { validGeneratedAssets, type AssetLimits } from '../assets/files'
import {
  publicEvent,
  planPublicReceipts,
} from '../conversation/execution-receipts'
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
  if (!Number.isSafeInteger(delivery.ordinal) || delivery.ordinal < 1)
    return 'conflict'
  const event = publicEvent(delivery.event)
  try {
    return await db
      .transaction()
      .execute((tx) =>
        acceptReceipt(tx, { event, ordinal: delivery.ordinal }, limits),
      )
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

  if (
    event.kind === 'run-completed' &&
    !validGeneratedAssets(event, event.assets ?? [], limits)
  )
    throw receiptConflict
  await applyPublicFacts(tx, event)
  return 'accepted'
}

async function authorizedRun(
  tx: Transaction<DB>,
  event: ExecutionEvent,
): Promise<boolean> {
  // Serializes receipt effects AND cursor allocation through commit for this thread.
  const thread = await tx
    .selectFrom('product.threads')
    .select('thread_id')
    .where('thread_id', '=', event.threadID)
    .forUpdate()
    .executeTakeFirst()
  if (!thread) return false
  const start = await tx
    .selectFrom('product.command_outbox')
    .select('command_id')
    .where('thread_id', '=', event.threadID)
    .where('run_id', '=', event.runID)
    .where(sql<string>`command ->> 'kind'`, '=', 'start')
    .where(sql<boolean>`lower(command ->> 'threadID') = thread_id::text`)
    .where(sql<boolean>`lower(command ->> 'runID') = run_id::text`)
    .where(sql<boolean>`lower(command ->> 'commandID') = command_id::text`)
    .where(
      sql<boolean>`lower(command #>> '{input,messageID}') = message_id::text`,
    )
    .where(sql<string>`command ->> 'version'`, '=', '1')
    .executeTakeFirst()
  return start !== undefined
}

async function applyPublicFacts(
  tx: Transaction<DB>,
  event: ExecutionEvent,
): Promise<void> {
  const receipts = await tx
    .selectFrom('product.execution_events')
    .selectAll()
    .where('thread_id', '=', event.threadID)
    .where('run_id', '=', event.runID)
    .orderBy('ordinal', 'asc')
    .execute()
  const plan = planPublicReceipts(
    receipts.map((receipt) => ({
      event: executionEventSchema.parse(receipt.payload),
      ordinal: BigInt(receipt.ordinal),
      processed: receipt.processed,
    })),
  )
  if (plan.kind === 'conflict') throw receiptConflict
  await storeFinalMessage(tx, event)

  for (const publication of plan.publications) {
    await tx
      .updateTable('product.execution_events')
      .set({
        processed: true,
        replay_cursor: publication.suppressed
          ? null
          : sql<string>`nextval('product.execution_event_replay_cursor')`,
      })
      .where('event_id', '=', publication.eventID)
      .execute()
  }
}

async function storeFinalMessage(
  tx: Transaction<DB>,
  event: ExecutionEvent,
): Promise<void> {
  if (event.kind === 'run-completed') {
    // Never adopt an existing message ID, even if its text happens to match.
    const message = await tx
      .insertInto('product.messages')
      .values({
        message_id: event.messageID,
        thread_id: event.threadID,
        role: 'assistant',
        text: event.text,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning('message_id')
      .executeTakeFirst()
    if (!message) throw receiptConflict
    await storeAssets(tx, event)
  }
}

/** Cursor scope is one owned thread. null means the thread is missing or not owned. */
export async function readPublicEvents(
  db: Kysely<DB>,
  query: Readonly<{
    ownerID: string
    threadID: string
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
    .innerJoin(
      'product.threads',
      'product.threads.thread_id',
      'product.execution_events.thread_id',
    )
    .select(['payload', 'ordinal', 'replay_cursor'])
    .where('product.threads.owner_id', '=', query.ownerID)
    .where('product.execution_events.thread_id', '=', query.threadID)
    .where('replay_cursor', '>', query.after ?? '0')
    .orderBy('replay_cursor', 'asc')
    .limit(query.limit ?? 1000)
    .execute()
  return rows.map((row) => {
    if (row.replay_cursor === null)
      throw new Error('Missing published replay cursor')
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
