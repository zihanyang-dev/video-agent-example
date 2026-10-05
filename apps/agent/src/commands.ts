import type { RedisClientType } from 'redis'
import {
  executionCommandSchema,
  executionStreams,
  type ExecutionCommand,
} from '@vid/contract/execution'
import type { Kysely } from 'kysely'
import type { DB } from '@vid/database/types'
import { acceptExecutionCommand } from './db/command-acceptance'

type CommandConsumer = {
  commands: RedisClientType
  blockingReader: RedisClientType
  consumerID: string
}

type PendingCommands = Awaited<
  ReturnType<RedisClientType['xAutoClaim']>
>['messages']

export async function initializeCommands(commands: RedisClientType) {
  try {
    await commands.xGroupCreate(
      executionStreams.commands,
      executionStreams.commandGroup,
      '0-0',
      { MKSTREAM: true },
    )
  } catch (cause) {
    if (!(cause instanceof Error) || !cause.message.startsWith('BUSYGROUP '))
      throw cause
  }
}

/** Commit each command before ACK. Poison and missing payloads remain pending;
 * the process owner stops intake rather than guessing what was delivered. */
export async function acceptCommandMessages(
  db: Kysely<DB>,
  commands: RedisClientType,
  messages: PendingCommands,
) {
  let acceptedCount = 0
  for (const entry of messages) {
    if (entry === null) throw new Error('Deleted pending command payload')
    const body = entry.message.command
    if (body === undefined) throw new Error('Missing pending command payload')

    let command: ExecutionCommand
    try {
      command = executionCommandSchema.parse(JSON.parse(body))
    } catch {
      // Parser diagnostics can include private wire content. Fail-stop without
      // forwarding it into process logs; no acceptance or ACK has happened.
      throw new Error('Invalid pending command payload')
    }

    const outcome = await acceptExecutionCommand(db, command)
    if (outcome === 'conflict')
      throw new Error('Execution command conflicts with accepted identity')

    await commands.xAck(
      executionStreams.commands,
      executionStreams.commandGroup,
      entry.id,
    )
    acceptedCount += 1
  }
  return acceptedCount
}

export async function acceptCommands(
  db: Kysely<DB>,
  consumer: CommandConsumer,
  signal: AbortSignal,
) {
  const { commands, blockingReader, consumerID } = consumer
  let cursor = '0-0'

  while (!signal.aborted) {
    const page = await commands.xAutoClaim(
      executionStreams.commands,
      executionStreams.commandGroup,
      consumerID,
      1000,
      cursor,
      { COUNT: 32 },
    )
    // Advance even across empty pages; deleted PEL entries are data loss.
    cursor = page.nextId
    if (signal.aborted) return
    if (page.deletedMessages.length)
      throw new Error('Deleted pending command payloads')
    await acceptCommandMessages(db, commands, page.messages)

    if (signal.aborted) return
    const streams = await blockingReader.xReadGroup(
      executionStreams.commandGroup,
      consumerID,
      { key: executionStreams.commands, id: '>' },
      { COUNT: 32, BLOCK: 200 },
    )
    if (signal.aborted) return
    for (const stream of streams ?? [])
      await acceptCommandMessages(db, commands, stream.messages)
  }
}
