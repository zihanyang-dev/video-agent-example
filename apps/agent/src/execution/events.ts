import { setTimeout } from 'node:timers/promises'
import type { Kysely } from 'kysely'
import type { DB } from '@vid/database/types'
import { executionStreams } from '@vid/contract/execution'
import type { RedisClientType } from 'redis'
import { publishEvent, pendingEventIDs, sweepPublishedEvents } from './db/event-publication'

// Retention is a background cadence, not a per-poll cost.
const sweepIntervalMs = 3600000

export async function relayEvents(
  db: Kysely<DB>,
  commands: RedisClientType,
  polling: Readonly<{
    signal: AbortSignal
    pollMs: number
    retentionMs: number
  }>,
) {
  let nextSweepAt = 0
  while (!polling.signal.aborted) {
    await publishPendingEvents(db, commands, polling.signal)
    if (polling.signal.aborted) break
    if (Date.now() >= nextSweepAt) {
      nextSweepAt = Date.now() + sweepIntervalMs
      await sweepPublishedEvents(db, polling.retentionMs)
    }
    await waitForPublicationPoll(polling)
  }
}

async function publishPendingEvents(
  db: Kysely<DB>,
  commands: RedisClientType,
  signal: AbortSignal,
) {
  const pending = await pendingEventIDs(db)
  for (const row of pending) {
    if (signal.aborted) break
    await publishEvent(db, {
      eventID: row.event_id,
      publish: async (delivery) => {
        await commands.xAdd(executionStreams.events, '*', {
          delivery: JSON.stringify(delivery),
        })
      },
    })
  }
}

async function waitForPublicationPoll(polling: Readonly<{ signal: AbortSignal; pollMs: number }>) {
  try {
    await setTimeout(polling.pollMs, undefined, { signal: polling.signal })
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) throw error
  }
}
