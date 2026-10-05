import { afterAll, expect, test } from 'bun:test'
import type { ExecutionCommand } from '@vid/contract/execution'
import { acceptMessageIntent } from '../../apps/server/src/db/submissions'
import { publishCommands } from '../../apps/server/src/db/command-publication'
import { seedTestUser, openTestDatabase } from './database-fixture'

const { db, close } = openTestDatabase()
const threadID = crypto.randomUUID()
const ownerID = 'command-relay-owner'

afterAll(async () => {
  try {
    await db
      .deleteFrom('product.command_outbox')
      .where('thread_id', '=', threadID)
      .execute()
    await db
      .deleteFrom('product.messages')
      .where('thread_id', '=', threadID)
      .execute()
    await db
      .deleteFrom('product.threads')
      .where('thread_id', '=', threadID)
      .execute()
  } finally {
    await close()
  }
})

async function accept(text: string) {
  const result = await acceptMessageIntent(db, {
    ownerID,
    threadID,
    messageID: crypto.randomUUID(),
    commandID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    text,
  })
  if (result.kind !== 'accepted')
    throw new Error('Expected an accepted command')
  return result.commandID
}

test('a bounded relay finds committed commands without caller-supplied IDs and resumes after failure', async () => {
  await seedTestUser(db, ownerID)
  await db
    .insertInto('product.threads')
    .values({ thread_id: threadID, owner_id: ownerID })
    .execute()
  const first = await accept('First')
  const second = await accept('Second')
  const sent: ExecutionCommand[] = []
  const publish = async (command: ExecutionCommand) => {
    sent.push(command)
  }

  expect(await publishCommands(db, { limit: 1, publish })).toBe(1)
  expect(sent.map((command) => command.commandID)).toEqual([first])

  const unavailable = new Error('Transport unavailable')
  expect(
    publishCommands(db, {
      limit: 1,
      publish: async () => {
        throw unavailable
      },
    }),
  ).rejects.toBe(unavailable)
  const pending = await db
    .selectFrom('product.command_outbox')
    .select('published_at')
    .where('command_id', '=', second)
    .executeTakeFirstOrThrow()
  expect(pending.published_at).toBeNull()

  expect(await publishCommands(db, { limit: 10, publish })).toBe(1)
  expect(sent.map((command) => command.commandID)).toEqual([first, second])
  expect(await publishCommands(db, { limit: 10, publish })).toBe(0)
})

test('invalid batch bounds fail before publication', async () => {
  for (const limit of [0, -1, 1.5, Infinity]) {
    expect(
      publishCommands(db, {
        limit,
        publish: async () => {
          throw new Error('Invalid batch published a command')
        },
      }),
    ).rejects.toBeInstanceOf(RangeError)
  }
})
