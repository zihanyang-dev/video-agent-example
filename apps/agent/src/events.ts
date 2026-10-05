import { setTimeout } from 'node:timers/promises'
import type { Kysely } from 'kysely'
import type { DB } from '@vid/database/types'
import { executionStreams } from '@vid/contract/execution'
import type { RedisClientType } from 'redis'
import { publishEvent, pendingEventIDs } from './db/event-publication'

export async function relayEvents(
  db: Kysely<DB>,
  commands: RedisClientType,
  polling: Readonly<{ signal: AbortSignal; pollMs: number }>,
) {
  while (!polling.signal.aborted) {
    await publishPendingEvents(db, commands, polling.signal)
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

async function waitForPublicationPoll(
  polling: Readonly<{ signal: AbortSignal; pollMs: number }>,
) {
  try {
    await setTimeout(polling.pollMs, undefined, { signal: polling.signal })
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) throw error
  }
}
