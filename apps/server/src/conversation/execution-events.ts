import type { AssetLimits } from '../assets/files'
import type { DB } from '@vid/database/types'
import {
  executionDeliverySchema,
  executionStreams,
  type ExecutionDelivery,
} from '@vid/contract/execution'
import type { RedisClientType } from 'redis'
import type { Kysely } from 'kysely'
import { acceptExecutionEvent } from '../db/execution-events'

/** Process one caller-bounded readNew/reclaim batch. Commit acceptance before ACK;
 * replay is accepted by the durable acceptor. Caller owns Redis lifecycle/cursors.
 */
export async function consumeEventBatch(
  db: Kysely<DB>,
  batch: Readonly<{
    commands: RedisClientType
    messages: ReadonlyArray<{
      id: string
      message: Readonly<Record<string, string>> | null
    } | null>
    assetLimits?: AssetLimits
    deletedMessages?: readonly string[]
  }>,
): Promise<number> {
  // XAUTOCLAIM itself removes deleted entries from the PEL; never hide data loss.
  if (batch.deletedMessages?.length)
    throw new Error(
      `Deleted pending delivery payloads: ${batch.deletedMessages.join(', ')}`,
    )

  let accepted = 0
  for (const entry of batch.messages) {
    if (entry === null) throw new Error('Deleted pending delivery payload')
    const body = entry.message?.delivery
    if (body === undefined)
      throw new Error(`Missing pending delivery payload: ${entry.id}`)
    let delivery: ExecutionDelivery
    try {
      delivery = executionDeliverySchema.parse(JSON.parse(body))
    } catch {
      // Neither JSON diagnostics nor schema issues may expose private payloads.
      throw new Error('Invalid pending delivery payload')
    }
    const outcome = await acceptExecutionEvent(db, delivery, batch.assetLimits)
    if (outcome !== 'accepted')
      throw new Error(`Execution delivery rejected (${outcome}): ${entry.id}`)
    await batch.commands.xAck(
      executionStreams.events,
      executionStreams.eventGroup,
      entry.id,
    )
    accepted += 1
  }
  return accepted
}
