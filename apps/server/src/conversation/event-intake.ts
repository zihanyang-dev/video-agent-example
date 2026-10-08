import { executionStreams } from '@vid/contract/execution'
import type { DB } from '@vid/database/types'
import type { Kysely } from 'kysely'
import type { RedisClientType } from 'redis'
import type { AssetLimits } from '../assets/files'
import { consumeEventBatch } from './execution-events'

/** Accept reclaimed and new deliveries; the caller owns connections and task settlement. */
export function acceptEventDeliveries(
  db: Kysely<DB>,
  {
    commands,
    blockingReader,
    signal,
    assetLimits,
    onFailure,
  }: Readonly<{
    commands: RedisClientType
    blockingReader: RedisClientType
    signal: AbortSignal
    assetLimits: AssetLimits
    onFailure: (stage: 'rediscommand' | 'redisread' | 'eventreceipt', cause: unknown) => void
  }>,
) {
  const consumer = crypto.randomUUID()
  let startID = '0-0'
  let stage: 'rediscommand' | 'redisread' | 'eventreceipt' = 'rediscommand'
  const intake = (async () => {
    while (!signal.aborted) {
      stage = 'rediscommand'
      const reclaimed = await commands.xAutoClaim(
        executionStreams.events,
        executionStreams.eventGroup,
        consumer,
        1000,
        startID,
        { COUNT: 32 },
      )
      startID = reclaimed.nextId // Empty pages still advance the native cursor.
      if (signal.aborted) return
      stage = 'eventreceipt'
      await consumeEventBatch(db, {
        commands,
        assetLimits,
        signal,
        messages: reclaimed.messages,
        deletedMessages: reclaimed.deletedMessages,
      })
      if (signal.aborted) return
      stage = 'redisread'
      const streams = await blockingReader.xReadGroup(
        executionStreams.eventGroup,
        consumer,
        { key: executionStreams.events, id: '>' },
        { COUNT: 32, BLOCK: 200 },
      )
      // Newly claimed deliveries stay pending for the replacement during stop.
      if (signal.aborted) return
      stage = 'eventreceipt'
      await consumeEventBatch(db, {
        commands,
        assetLimits,
        signal,
        messages: streams?.flatMap((stream) => stream.messages) ?? [],
      })
    }
  })()
  return intake.catch((cause: unknown) => onFailure(stage, cause))
}
