import type { DB } from '@vid/database/types'
import { executionStreams } from '@vid/contract/execution'
import type { Kysely } from 'kysely'
import type { RedisClientType } from 'redis'
import { publishCommands } from '../db/command-publication'

// The process owns and awaits this loop before destroying Redis/PG. The client
// has a configured command timeout: abort stops new batches, but a publication
// already in flight must resolve or reject so its SQL transaction can settle.
export async function publishPendingCommands(
  db: Kysely<DB>,
  commands: RedisClientType,
  polling: Readonly<{ signal: AbortSignal; pollMs: number }>,
) {
  while (!polling.signal.aborted) {
    await publishCommands(db, {
      limit: 32,
      publish: async (command) => {
        await commands.xAdd(executionStreams.commands, '*', {
          command: JSON.stringify(command),
        })
      },
    })
    await waitForPublicationPoll(polling.pollMs, polling.signal)
  }
}

function waitForPublicationPoll(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}
