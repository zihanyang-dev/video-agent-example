import { afterAll, expect, test } from 'bun:test'
import {
  executionCommandSchema,
  type ExecutionCommand,
} from '@vid/contract/execution'
import { createClient } from 'redis'
import { sql } from 'kysely'
import { publishCommand } from '../../apps/server/src/db/command-publication'
import { acceptMessageIntent } from '../../apps/server/src/db/submissions'
import { seedTestUser, openTestDatabase } from './database-fixture'

const { db, close } = openTestDatabase()
const threadIDs: string[] = []
afterAll(async () => {
  try {
    if (threadIDs.length === 0) return
    await db
      .deleteFrom('product.command_outbox')
      .where('thread_id', 'in', threadIDs)
      .execute()
    await db
      .deleteFrom('product.messages')
      .where('thread_id', 'in', threadIDs)
      .execute()
    await db
      .deleteFrom('product.threads')
      .where('thread_id', 'in', threadIDs)
      .execute()
  } finally {
    await close()
  }
})

async function pendingCommand(threadID: string = crypto.randomUUID()) {
  const intent = {
    ownerID: 'publication-test-owner',
    threadID,
    messageID: crypto.randomUUID(),
    commandID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    text: 'Hello',
  }
  await seedTestUser(db, intent.ownerID)
  await db
    .insertInto('product.threads')
    .values({
      thread_id: intent.threadID,
      owner_id: intent.ownerID,
    })
    .execute()
  threadIDs.push(intent.threadID)
  const accepted = await acceptMessageIntent(db, intent)
  if (accepted.kind !== 'accepted')
    throw new Error('Fixture command was not accepted')
  return intent
}

async function publishedAt(commandID: string) {
  const command = await db
    .selectFrom('product.command_outbox')
    .select('published_at')
    .where('command_id', '=', commandID)
    .executeTakeFirstOrThrow()
  return command.published_at
}

test('a committed command is published once and marked only after successful publication', async () => {
  const intent = await pendingCommand()
  const commands: ExecutionCommand[] = []
  const publication = {
    commandID: intent.commandID,
    publish: async (command: ExecutionCommand) => {
      commands.push(command)
    },
  }
  expect(await publishedAt(intent.commandID)).toBeNull()
  expect(await publishCommand(db, publication)).toBe('published')
  expect(await publishedAt(intent.commandID)).toBeInstanceOf(Date)
  expect(await publishCommand(db, publication)).toBe('skipped')
  expect(commands).toHaveLength(1)
  expect(commands[0]).toMatchObject({
    commandID: intent.commandID,
    input: { text: 'Hello' },
  })
})

test('failed publication leaves the original command pending for retry', async () => {
  const intent = await pendingCommand()
  const failure = new Error('Transport unavailable')
  expect(
    publishCommand(db, {
      commandID: intent.commandID,
      publish: async () => {
        throw failure
      },
    }),
  ).rejects.toBe(failure)
  expect(await publishedAt(intent.commandID)).toBeNull()
  expect(
    await publishCommand(db, {
      commandID: intent.commandID,
      publish: async () => {},
    }),
  ).toBe('published')
})

test('concurrent publishers skip a locked command without acknowledging it', async () => {
  const intent = await pendingCommand()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const first = publishCommand(db, {
    commandID: intent.commandID,
    publish: async () => {
      entered.resolve()
      await release.promise
    },
  })
  try {
    await entered.promise
    expect(await publishedAt(intent.commandID)).toBeNull()
    expect(
      await publishCommand(db, {
        commandID: intent.commandID,
        publish: async () => {
          throw new Error('Locked command was published twice')
        },
      }),
    ).toBe('skipped')
  } finally {
    release.resolve()
    await first
  }
  expect(await publishedAt(intent.commandID)).toBeInstanceOf(Date)
})

test('a missing command does not invoke publication', async () => {
  expect(
    await publishCommand(db, {
      commandID: crypto.randomUUID(),
      publish: async () => {
        throw new Error('Missing command was published')
      },
    }),
  ).toBe('skipped')
})

test('malformed stored JSON is neither published nor acknowledged', async () => {
  const intent = await pendingCommand()
  await db
    .updateTable('product.command_outbox')
    .set({ command: { version: 1, kind: 'start' } })
    .where('command_id', '=', intent.commandID)
    .execute()
  const { redis, stream, closeStream } = publicationStream()
  try {
    await redis.connect()
    expect(
      publishCommand(db, {
        commandID: intent.commandID,
        publish: async (command) => {
          await redis.xAdd(stream, '*', { command: JSON.stringify(command) })
        },
      }),
    ).rejects.toThrow()
    expect(await redis.xLen(stream)).toBe(0)
    expect(await publishedAt(intent.commandID)).toBeNull()
  } finally {
    await closeStream()
  }
})

test.each(['commandID', 'threadID', 'runID', 'messageID'] as const)(
  'stored %s must match the outbox identities before publication',
  async (field) => {
    const intent = await pendingCommand()
    const stored = await db
      .selectFrom('product.command_outbox')
      .select('command')
      .where('command_id', '=', intent.commandID)
      .executeTakeFirstOrThrow()
    const command = executionCommandSchema.parse(stored.command)
    if (command.kind !== 'start') throw new Error('Expected a start command')
    const mismatched =
      field === 'messageID'
        ? {
            ...command,
            input: { ...command.input, messageID: crypto.randomUUID() },
          }
        : { ...command, [field]: crypto.randomUUID() }
    await db
      .updateTable('product.command_outbox')
      .set({ command: sql`${JSON.stringify(mismatched)}::jsonb` })
      .where('command_id', '=', intent.commandID)
      .execute()
    const { redis, stream, closeStream } = publicationStream()
    try {
      await redis.connect()
      expect(
        publishCommand(db, {
          commandID: intent.commandID,
          publish: async (command) => {
            await redis.xAdd(stream, '*', { command: JSON.stringify(command) })
          },
        }),
      ).rejects.toThrow(
        'Stored command identities do not match the outbox record',
      )
      expect(await redis.xLen(stream)).toBe(0)
      expect(await publishedAt(intent.commandID)).toBeNull()
    } finally {
      await closeStream()
    }
  },
)

function publicationStream() {
  const redisURL = process.env.REDIS_URL
  if (!redisURL)
    throw new Error('REDIS_URL is required for publication integration tests')
  const redis = createClient({
    url: redisURL,
    socket: { reconnectStrategy: false },
  })
  redis.on('error', console.error)
  const stream = `command-publication-test:${crypto.randomUUID()}`
  return {
    redis,
    stream,
    closeStream: async () => {
      if (!redis.isOpen) return
      try {
        await redis.del(stream)
      } finally {
        await redis.close()
      }
    },
  }
}

test('a lost Redis acceptance receipt can duplicate delivery but preserves command identities', async () => {
  const { redis, stream, closeStream } = publicationStream()
  const intent = await pendingCommand()
  const lostReceipt = new Error(
    'Redis accepted the command but its receipt was lost',
  )
  try {
    await redis.connect()
    expect(
      publishCommand(db, {
        commandID: intent.commandID,
        publish: async (command) => {
          await redis.xAdd(stream, '*', { command: JSON.stringify(command) })
          throw lostReceipt
        },
      }),
    ).rejects.toBe(lostReceipt)
    expect(await publishedAt(intent.commandID)).toBeNull()
    expect(await redis.xLen(stream)).toBe(1)

    expect(
      await publishCommand(db, {
        commandID: intent.commandID,
        publish: async (command) => {
          await redis.xAdd(stream, '*', { command: JSON.stringify(command) })
          // Redis has accepted the retry, but the callback has not returned acceptance yet.
          expect(await publishedAt(intent.commandID)).toBeNull()
        },
      }),
    ).toBe('published')
    expect(await publishedAt(intent.commandID)).toBeInstanceOf(Date)
    const entries = await redis.xRange(stream, '-', '+')
    expect(entries).toHaveLength(2)
    if (entries === null) throw new Error('Expected recorded Redis commands')
    expect(entries[0]?.id).not.toBe(entries[1]?.id)
    for (const entry of entries) {
      const command = executionCommandSchema.parse(
        JSON.parse(entry.message.command ?? 'null'),
      )
      expect(command).toEqual({
        version: 1,
        kind: 'start',
        commandID: intent.commandID,
        threadID: intent.threadID,
        runID: intent.runID,
        input: { messageID: intent.messageID, text: 'Hello' },
      })
    }
  } finally {
    await closeStream()
  }
})

test('legacy uppercase JSON identities match canonical outbox headers and publish canonical JSON', async () => {
  const intent = await pendingCommand('abcdefab-cdef-4abc-8def-abcdefabcded')
  const command = {
    version: 1,
    kind: 'start',
    commandID: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF',
    threadID: intent.threadID.toUpperCase(),
    runID: 'BCDEFABC-DEFA-4BCD-8EFA-BCDEFABCDEFA',
    input: { messageID: 'CDEFABCD-EFAB-4CDE-8FAB-CDEFABCDEFAB', text: 'Hello' },
  } as const
  // Use known alphabetic UUIDs; keep FK-backed thread and message columns intact.
  await db
    .insertInto('product.messages')
    .values({
      message_id: command.input.messageID,
      thread_id: intent.threadID,
      role: 'user',
      text: 'Hello',
    })
    .execute()
  await db
    .updateTable('product.command_outbox')
    .set({
      command_id: command.commandID,
      run_id: command.runID,
      message_id: command.input.messageID,
      command,
    })
    .where('command_id', '=', intent.commandID)
    .execute()
  const { redis, stream, closeStream } = publicationStream()
  try {
    await redis.connect()
    expect(
      await publishCommand(db, {
        commandID: command.commandID,
        publish: async (published) => {
          await redis.xAdd(stream, '*', { command: JSON.stringify(published) })
        },
      }),
    ).toBe('published')
    const entries = await redis.xRange(stream, '-', '+')
    if (entries === null) {
      throw new Error('Expected published Redis command')
    }
    expect(entries).toHaveLength(1)
    expect(JSON.parse(entries[0]?.message.command ?? 'null')).toEqual({
      ...command,
      commandID: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
      threadID: intent.threadID,
      runID: 'bcdefabc-defa-4bcd-8efa-bcdefabcdefa',
      input: {
        messageID: 'cdefabcd-efab-4cde-8fab-cdefabcdefab',
        text: 'Hello',
      },
    })
  } finally {
    await closeStream()
  }
})
