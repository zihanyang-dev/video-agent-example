import { afterAll, expect, test } from 'bun:test'
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

async function createThread() {
  const thread_id = crypto.randomUUID()
  await seedTestUser(db, 'database-test-owner')
  await db
    .insertInto('product.threads')
    .values({ thread_id, owner_id: 'database-test-owner' })
    .execute()
  threadIDs.push(thread_id)
  return thread_id
}

test('a message cannot refer to an absent thread', async () => {
  expect(
    await db
      .insertInto('product.messages')
      .values({
        message_id: crypto.randomUUID(),
        thread_id: crypto.randomUUID(),
        role: 'user',
        text: 'Orphan',
      })
      .execute()
      .catch((error: unknown) => error),
  ).toMatchObject({ code: '23503' })
})

test('an outbox command cannot refer to an absent thread', async () => {
  expect(
    await db
      .insertInto('product.command_outbox')
      .values({
        command_id: crypto.randomUUID(),
        thread_id: crypto.randomUUID(),
        run_id: crypto.randomUUID(),
        command: {},
      })
      .execute()
      .catch((error: unknown) => error),
  ).toMatchObject({ code: '23503' })
})

test('conflicting message IDs cannot replace the accepted text', async () => {
  const thread_id = await createThread()
  const message_id = crypto.randomUUID()
  await db
    .insertInto('product.messages')
    .values({ message_id, thread_id, role: 'user', text: 'Accepted' })
    .execute()

  expect(
    await db
      .insertInto('product.messages')
      .values({ message_id, thread_id, role: 'assistant', text: 'Conflicting' })
      .execute()
      .catch((error: unknown) => error),
  ).toMatchObject({ code: '23505' })
  const savedMessages = await db
    .selectFrom('product.messages')
    .selectAll()
    .where('message_id', '=', message_id)
    .execute()
  expect(savedMessages).toHaveLength(1)
  expect(savedMessages[0]?.text).toBe('Accepted')
})

test('conflicting command IDs cannot replace the pending command', async () => {
  const thread_id = await createThread()
  const command_id = crypto.randomUUID()
  const run_id = crypto.randomUUID()
  await db
    .insertInto('product.command_outbox')
    .values({ command_id, thread_id, run_id, command: { text: 'Accepted' } })
    .execute()

  expect(
    await db
      .insertInto('product.command_outbox')
      .values({
        command_id,
        thread_id,
        run_id: crypto.randomUUID(),
        command: { text: 'Conflicting' },
      })
      .execute()
      .catch((error: unknown) => error),
  ).toMatchObject({ code: '23505' })
  const pendingCommands = await db
    .selectFrom('product.command_outbox')
    .selectAll()
    .where('command_id', '=', command_id)
    .execute()
  expect(pendingCommands).toHaveLength(1)
  expect(pendingCommands[0]).toMatchObject({
    run_id,
    command: { text: 'Accepted' },
  })
})

test('only one start command can refer to an accepted message', async () => {
  const thread_id = await createThread()
  const message_id = crypto.randomUUID()
  await db
    .insertInto('product.messages')
    .values({ message_id, thread_id, role: 'user', text: 'Accepted' })
    .execute()
  const command_id = crypto.randomUUID()
  await db
    .insertInto('product.command_outbox')
    .values({
      command_id,
      thread_id,
      message_id,
      run_id: crypto.randomUUID(),
      command: {},
    })
    .execute()

  expect(
    await db
      .insertInto('product.command_outbox')
      .values({
        command_id: crypto.randomUUID(),
        thread_id,
        message_id,
        run_id: crypto.randomUUID(),
        command: {},
      })
      .execute()
      .catch((error: unknown) => error),
  ).toMatchObject({ code: '23505' })
  const saved = await db
    .selectFrom('product.command_outbox')
    .selectAll()
    .where('message_id', '=', message_id)
    .execute()
  expect(saved).toHaveLength(1)
  expect(saved[0]?.command_id).toBe(command_id)
})

test('a start command cannot refer to an absent message', async () => {
  const thread_id = await createThread()
  expect(
    await db
      .insertInto('product.command_outbox')
      .values({
        command_id: crypto.randomUUID(),
        thread_id,
        message_id: crypto.randomUUID(),
        run_id: crypto.randomUUID(),
        command: {},
      })
      .execute()
      .catch((error: unknown) => error),
  ).toMatchObject({ code: '23503' })
})

test('new threads must reference an existing real authentication user', async () => {
  const threadID = crypto.randomUUID()
  const rejected = await db
    .insertInto('product.threads')
    .values({ thread_id: threadID, owner_id: 'unknown-authentication-user' })
    .execute()
    .catch((cause: unknown) => cause)
  expect(rejected).toMatchObject({ code: '23503' })
  expect(
    await db
      .selectFrom('product.threads')
      .select('thread_id')
      .where('thread_id', '=', threadID)
      .execute(),
  ).toEqual([])
})
