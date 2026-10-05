import { afterAll, expect, test } from 'bun:test'
import type { ExecutionEvent } from '@vid/contract/execution'
import { sql } from 'kysely'
import {
  acceptExecutionEvent,
  readPublicEvents,
} from '../../apps/server/src/db/execution-events'
import { acceptMessageIntent } from '../../apps/server/src/db/submissions'
import { seedTestUser, openTestDatabase } from './database-fixture'

const { db, close } = openTestDatabase()
const threads: string[] = []
afterAll(async () => {
  try {
    if (threads.length === 0) return
    await db
      .deleteFrom('product.execution_events')
      .where('thread_id', 'in', threads)
      .execute()
    await db
      .deleteFrom('product.command_outbox')
      .where('thread_id', 'in', threads)
      .execute()
    await db
      .deleteFrom('product.messages')
      .where('thread_id', 'in', threads)
      .execute()
    await db
      .deleteFrom('product.threads')
      .where('thread_id', 'in', threads)
      .execute()
  } finally {
    await close()
  }
})
async function fixture() {
  const intent = {
    ownerID: 'receipt-owner',
    threadID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    commandID: crypto.randomUUID(),
    messageID: crypto.randomUUID(),
    text: 'hello',
  }
  await seedTestUser(db, intent.ownerID)
  await db
    .insertInto('product.threads')
    .values({ thread_id: intent.threadID, owner_id: intent.ownerID })
    .execute()
  threads.push(intent.threadID)
  await acceptMessageIntent(db, intent)
  const start: ExecutionEvent = {
    version: 1,
    kind: 'run-started',
    eventID: crypto.randomUUID(),
    threadID: intent.threadID,
    runID: intent.runID,
  }
  return { ...intent, start }
}

test('typed uppercase receipts replay canonically without duplicate public messages', async () => {
  const f = await fixture()
  const event: ExecutionEvent = {
    ...f.start,
    eventID: 'd1000000-0000-4000-8000-000000000001',
    kind: 'run-completed',
    messageID: 'e1000000-0000-4000-8000-000000000001',
    text: 'Canonical answer',
  }
  const uppercase: ExecutionEvent = {
    ...event,
    eventID: event.eventID.toUpperCase(),
    threadID: event.threadID.toUpperCase(),
    runID: event.runID.toUpperCase(),
    messageID: event.messageID.toUpperCase(),
  }
  expect(await acceptExecutionEvent(db, { ordinal: 1, event: uppercase })).toBe(
    'accepted',
  )
  expect(await acceptExecutionEvent(db, { ordinal: 1, event })).toBe('accepted')
  const replay = await readPublicEvents(db, {
    ownerID: f.ownerID,
    threadID: f.threadID,
  })
  expect(replay).toHaveLength(1)
  expect(replay?.[0]?.event).toEqual(event)
  const messages = await db
    .selectFrom('product.messages')
    .select(['message_id', 'text'])
    .where('thread_id', '=', f.threadID)
    .where('role', '=', 'assistant')
    .execute()
  expect(messages).toEqual([
    { message_id: event.messageID, text: 'Canonical answer' },
  ])
})

test('unknown run creates neither receipt nor final message', async () => {
  const f = await fixture()
  const event: ExecutionEvent = {
    ...f.start,
    runID: crypto.randomUUID(),
    kind: 'run-completed',
    messageID: crypto.randomUUID(),
    text: 'no',
  }
  expect(await acceptExecutionEvent(db, { event, ordinal: 1 })).toBe(
    'unknown-run',
  )
  expect(
    await db
      .selectFrom('product.execution_events')
      .selectAll()
      .where('thread_id', '=', f.threadID)
      .execute(),
  ).toHaveLength(0)
  expect(
    await db
      .selectFrom('product.messages')
      .selectAll()
      .where('message_id', '=', event.messageID)
      .execute(),
  ).toHaveLength(0)
})

test('concurrent identical receipts are idempotent; changed body, ordinal and ordinal identity conflict', async () => {
  const f = await fixture()
  expect(
    await Promise.all([
      acceptExecutionEvent(db, { event: f.start, ordinal: 1 }),
      acceptExecutionEvent(db, { event: f.start, ordinal: 1 }),
    ]),
  ).toEqual(['accepted', 'accepted'])
  expect(await acceptExecutionEvent(db, { event: f.start, ordinal: 2 })).toBe(
    'conflict',
  )
  expect(
    await acceptExecutionEvent(db, {
      event: { ...f.start, kind: 'run-failed', reason: 'interrupted' },
      ordinal: 1,
    }),
  ).toBe('conflict')
  expect(
    await acceptExecutionEvent(db, {
      event: { ...f.start, eventID: crypto.randomUUID() },
      ordinal: 1,
    }),
  ).toBe('conflict')
  const replay = await readPublicEvents(db, {
    ownerID: f.ownerID,
    threadID: f.threadID,
  })
  expect(replay?.map((item) => item.event)).toEqual([f.start])
  expect(
    await readPublicEvents(db, { ownerID: 'other', threadID: f.threadID }),
  ).toBeNull()
})

test('completion before delta and start stores final text once, holds replay gaps and suppresses late delta', async () => {
  const f = await fixture()
  const completed: ExecutionEvent = {
    ...f.start,
    eventID: crypto.randomUUID(),
    kind: 'run-completed',
    messageID: crypto.randomUUID(),
    text: 'canonical',
  }
  const delta: ExecutionEvent = {
    ...f.start,
    eventID: crypto.randomUUID(),
    kind: 'assistant-text',
    messageID: completed.messageID,
    delta: 'partial',
  }
  expect(await acceptExecutionEvent(db, { event: completed, ordinal: 3 })).toBe(
    'accepted',
  )
  expect(
    await readPublicEvents(db, { ownerID: f.ownerID, threadID: f.threadID }),
  ).toEqual([])
  expect(await acceptExecutionEvent(db, { event: delta, ordinal: 2 })).toBe(
    'accepted',
  )
  expect(await acceptExecutionEvent(db, { event: f.start, ordinal: 1 })).toBe(
    'accepted',
  )
  expect(await acceptExecutionEvent(db, { event: completed, ordinal: 3 })).toBe(
    'accepted',
  )
  const replay = await readPublicEvents(db, {
    ownerID: f.ownerID,
    threadID: f.threadID,
  })
  expect(replay?.map((item) => item.event)).toEqual([f.start, completed])
  if (!replay?.[0]) throw new Error('Missing replay')
  expect(
    (
      await readPublicEvents(db, {
        ownerID: f.ownerID,
        threadID: f.threadID,
        after: replay[0].cursor,
      })
    )?.map((item) => item.event),
  ).toEqual([completed])
  await expectCanonicalMessage(completed.messageID)
  expect(
    await acceptExecutionEvent(db, {
      event: { ...delta, eventID: crypto.randomUUID() },
      ordinal: 4,
    }),
  ).toBe('accepted')
  expect(
    await readPublicEvents(db, { ownerID: f.ownerID, threadID: f.threadID }),
  ).toEqual(replay)
})

test('final message collision rolls back receipt and cursor allocation', async () => {
  const f = await fixture()
  const event: ExecutionEvent = {
    ...f.start,
    kind: 'run-completed',
    messageID: f.messageID,
    text: 'overwrite',
  }
  expect(await acceptExecutionEvent(db, { event, ordinal: 1 })).toBe('conflict')
  expect(
    await db
      .selectFrom('product.execution_events')
      .selectAll()
      .where('thread_id', '=', f.threadID)
      .execute(),
  ).toHaveLength(0)
  expect(
    await db
      .selectFrom('product.messages')
      .select('text')
      .where('message_id', '=', f.messageID)
      .executeTakeFirstOrThrow(),
  ).toEqual({ text: 'hello' })
})

test('thread locking prevents reconnect from skipping a delayed concurrent commit', async () => {
  const f = await fixture()
  const second: ExecutionEvent = {
    ...f.start,
    kind: 'assistant-text',
    eventID: crypto.randomUUID(),
    messageID: crypto.randomUUID(),
    delta: 'hi',
  }
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const blocker = db.transaction().execute(async (tx) => {
    await sql`select thread_id from product.threads where thread_id = ${f.threadID} for update`.execute(
      tx,
    )
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const first = acceptExecutionEvent(db, { event: f.start, ordinal: 1 })
  const next = acceptExecutionEvent(db, { event: second, ordinal: 2 })
  try {
    expect(
      await readPublicEvents(db, { ownerID: f.ownerID, threadID: f.threadID }),
    ).toEqual([])
  } finally {
    release.resolve()
    await blocker
  }
  expect(await Promise.all([first, next])).toEqual(['accepted', 'accepted'])
  const replay = await readPublicEvents(db, {
    ownerID: f.ownerID,
    threadID: f.threadID,
  })
  expect(replay?.map((item) => item.event)).toEqual([f.start, second])
  if (!replay?.[0]) throw new Error('Missing replay')
  expect(
    (
      await readPublicEvents(db, {
        ownerID: f.ownerID,
        threadID: f.threadID,
        after: replay[0].cursor,
      })
    )?.map((item) => item.event),
  ).toEqual([second])
})

test('terminal receipts cannot be followed by public started facts or replaced by another terminal', async () => {
  const f = await fixture()
  const cancelled: ExecutionEvent = { ...f.start, kind: 'run-cancelled' }
  expect(await acceptExecutionEvent(db, { event: cancelled, ordinal: 1 })).toBe(
    'accepted',
  )
  const lateStart = { ...f.start, eventID: crypto.randomUUID() }
  expect(await acceptExecutionEvent(db, { event: lateStart, ordinal: 2 })).toBe(
    'accepted',
  )
  const failed: ExecutionEvent = {
    ...f.start,
    eventID: crypto.randomUUID(),
    kind: 'run-failed',
    reason: 'execution-error',
  }
  expect(await acceptExecutionEvent(db, { event: failed, ordinal: 3 })).toBe(
    'conflict',
  )
  expect(
    (
      await readPublicEvents(db, { ownerID: f.ownerID, threadID: f.threadID })
    )?.map((row) => row.event),
  ).toEqual([cancelled])
})

test('concurrent different events claiming one ordinal have one winner and no duplicate replay', async () => {
  const f = await fixture()
  const other = { ...f.start, eventID: crypto.randomUUID() }
  const results = await Promise.all([
    acceptExecutionEvent(db, { event: f.start, ordinal: 1 }),
    acceptExecutionEvent(db, { event: other, ordinal: 1 }),
  ])
  expect(results.sort()).toEqual(['accepted', 'conflict'])
  const replay = await readPublicEvents(db, {
    ownerID: f.ownerID,
    threadID: f.threadID,
  })
  expect(replay).toHaveLength(1)
  expect(
    await db
      .selectFrom('product.execution_events')
      .selectAll()
      .where('thread_id', '=', f.threadID)
      .execute(),
  ).toHaveLength(1)
})

async function expectCanonicalMessage(messageID: string) {
  expect(
    await db
      .selectFrom('product.messages')
      .select(['role', 'text'])
      .where('message_id', '=', messageID)
      .execute(),
  ).toEqual([{ role: 'assistant', text: 'canonical' }])
}

test('receipt authority requires indexed start headers to match the durable wire command', async () => {
  const f = await fixture()
  await db
    .updateTable('product.command_outbox')
    .set({
      command: sql`jsonb_set(command, '{input,messageID}', to_jsonb(${crypto.randomUUID()}::text))`,
    })
    .where('command_id', '=', f.commandID)
    .execute()
  expect(await acceptExecutionEvent(db, { event: f.start, ordinal: 1 })).toBe(
    'unknown-run',
  )
  expect(
    await db
      .selectFrom('product.execution_events')
      .select('event_id')
      .where('thread_id', '=', f.threadID)
      .execute(),
  ).toEqual([])
})

test('a string-version start cannot authorize a completion or any receipt writes', async () => {
  const f = await fixture()
  await db
    .updateTable('product.command_outbox')
    .set({ command: sql`jsonb_set(command, '{version}', '"1"'::jsonb)` })
    .where('command_id', '=', f.commandID)
    .execute()
  const event: ExecutionEvent = {
    ...f.start,
    kind: 'run-completed',
    messageID: crypto.randomUUID(),
    text: 'must not adopt',
  }
  expect(await acceptExecutionEvent(db, { event, ordinal: 1 })).toBe(
    'unknown-run',
  )
  expect(
    await db
      .selectFrom('product.execution_events')
      .selectAll()
      .where('thread_id', '=', f.threadID)
      .execute(),
  ).toEqual([])
  expect(
    await db
      .selectFrom('product.messages')
      .selectAll()
      .where('message_id', '=', event.messageID)
      .execute(),
  ).toEqual([])
})
