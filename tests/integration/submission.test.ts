import { afterAll, expect, test } from 'bun:test'
import { startCommandSchema } from '@vid/execution-protocol'
import { createConversationWrites } from '../../apps/server/src/modules/conversation/conversations-postgres'
import { publishCommand } from '../../apps/server/src/modules/conversation/publish-command'
import { submitMessage } from '../../apps/server/src/modules/conversation/submit-message'
import { openTestDatabase } from './database-fixture'

const { db, close } = openTestDatabase()
const writes = createConversationWrites(db)
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

async function inputForThread() {
  const threadID = crypto.randomUUID()
  const ownerID = 'submission-test-owner'
  await db
    .insertInto('product.threads')
    .values({ thread_id: threadID, owner_id: ownerID })
    .execute()
  threadIDs.push(threadID)
  return { ownerID, threadID, messageID: crypto.randomUUID(), text: 'Hello' }
}

async function savedAcceptance(threadID: string) {
  return {
    messages: await db
      .selectFrom('product.messages')
      .selectAll()
      .where('thread_id', '=', threadID)
      .execute(),
    commands: await db
      .selectFrom('product.command_outbox')
      .selectAll()
      .where('thread_id', '=', threadID)
      .execute(),
  }
}

test('acceptance commits a normalized user message and a matching pending execution command', async () => {
  const input = await inputForThread()
  const accepted = await submitMessage(writes, { ...input, text: '  Hello  ' })
  expect(accepted.kind).toBe('accepted')
  if (accepted.kind !== 'accepted') throw new Error('Message was not accepted')

  const saved = await savedAcceptance(input.threadID)
  expect(saved.messages).toHaveLength(1)
  expect(saved.messages[0]).toMatchObject({
    message_id: input.messageID,
    text: 'Hello',
    role: 'user',
  })
  expect(saved.commands).toHaveLength(1)
  expect(saved.commands[0]).toMatchObject({
    command_id: accepted.commandID,
    run_id: accepted.runID,
    published_at: null,
  })
  expect(startCommandSchema.parse(saved.commands[0]?.command)).toEqual({
    version: 1,
    kind: 'start',
    commandID: accepted.commandID,
    runID: accepted.runID,
    threadID: input.threadID,
    input: { messageID: input.messageID, text: 'Hello' },
  })
})

test('foreign and missing threads are unavailable without storing an input or command', async () => {
  const input = await inputForThread()
  expect(
    await submitMessage(writes, { ...input, ownerID: 'other-owner' }),
  ).toEqual({ kind: 'unavailable' })
  expect(
    await submitMessage(writes, { ...input, threadID: crypto.randomUUID() }),
  ).toEqual({ kind: 'unavailable' })
  expect(await savedAcceptance(input.threadID)).toEqual({
    messages: [],
    commands: [],
  })
})

test('identical retries preserve execution IDs before and after publication', async () => {
  const input = await inputForThread()
  const first = await submitMessage(writes, input)
  expect(first.kind).toBe('accepted')
  expect(await submitMessage(writes, input)).toEqual(first)
  if (first.kind !== 'accepted') throw new Error('Message was not accepted')
  expect(
    await publishCommand(db, {
      commandID: first.commandID,
      publish: async () => {},
    }),
  ).toBe('published')
  expect(await submitMessage(writes, input)).toEqual(first)
  const saved = await savedAcceptance(input.threadID)
  expect(saved.messages).toHaveLength(1)
  expect(saved.commands).toHaveLength(1)
})

test('concurrent identical inputs commit exactly one message and pending command', async () => {
  const input = await inputForThread()
  const accepted = await Promise.all(
    Array.from({ length: 8 }, () => submitMessage(writes, input)),
  )
  const first = accepted[0]
  if (first === undefined) throw new Error('No submission outcome')
  expect(first.kind).toBe('accepted')
  for (const outcome of accepted) expect(outcome).toEqual(first)
  const saved = await savedAcceptance(input.threadID)
  expect(saved.messages).toHaveLength(1)
  expect(saved.commands).toHaveLength(1)
})

test('conflicting retries do not replace the accepted message or create another command', async () => {
  const input = await inputForThread()
  expect((await submitMessage(writes, input)).kind).toBe('accepted')
  expect(await submitMessage(writes, { ...input, text: 'Different' })).toEqual({
    kind: 'conflict',
  })
  const saved = await savedAcceptance(input.threadID)
  expect(saved.messages).toHaveLength(1)
  expect(saved.messages[0]?.text).toBe('Hello')
  expect(saved.commands).toHaveLength(1)
})

test('reusing a message ID for a different owned thread cannot borrow its execution', async () => {
  const first = await inputForThread()
  const second = await inputForThread()
  expect((await submitMessage(writes, first)).kind).toBe('accepted')
  expect(
    await submitMessage(writes, { ...second, messageID: first.messageID }),
  ).toEqual({ kind: 'conflict' })
  expect(await savedAcceptance(second.threadID)).toEqual({
    messages: [],
    commands: [],
  })
})

test('a command ID collision rolls back the newly inserted message', async () => {
  const input = await inputForThread()
  const first = await submitMessage(writes, input)
  if (first.kind !== 'accepted') throw new Error('Message was not accepted')
  const messageID = crypto.randomUUID()
  expect(
    await writes.submit({
      ...input,
      messageID,
      commandID: first.commandID,
      runID: crypto.randomUUID(),
    }),
  ).toEqual({ kind: 'conflict' })
  const saved = await savedAcceptance(input.threadID)
  expect(saved.messages).toHaveLength(1)
  expect(saved.messages[0]?.message_id).toBe(input.messageID)
  expect(saved.commands).toHaveLength(1)
})
