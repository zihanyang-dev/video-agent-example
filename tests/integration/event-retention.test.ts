import { afterAll, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { startCommandSchema, type StartCommand } from '@vid/contract/execution'
import { acceptExecutionCommand } from '../../apps/agent/src/execution/db/command-acceptance'
import { claimExecutionRun } from '../../apps/agent/src/execution/db/execution-leases'
import { bindExecutionWrites } from '../../apps/agent/src/execution/db/run-writes'
import { sweepPublishedEvents } from '../../apps/agent/src/execution/db/event-publication'
import { openTestDatabase, settleTestCleanup } from './database-fixture'

const { db, close } = openTestDatabase()
const ownedThreads = new Set<string>()
afterAll(async () => {
  const cleanups: (() => Promise<unknown>)[] = []
  for (const threadID of ownedThreads) {
    cleanups.push(() =>
      db
        .updateTable('execution.conversations')
        .set({ active_run_id: null, lease_owner: null, lease_until: null })
        .where('thread_id', '=', threadID)
        .execute(),
    )
    for (const table of [
      'execution.event_outbox',
      'execution.runs',
      'execution.command_inbox',
      'execution.conversations',
    ] as const) {
      cleanups.push(() => db.deleteFrom(table).where('thread_id', '=', threadID).execute())
    }
  }
  await settleTestCleanup([...cleanups, close])
})

const retentionMs = 30 * 24 * 3600000

async function claimedThread() {
  const threadID = crypto.randomUUID().toLowerCase()
  ownedThreads.add(threadID)
  const command: StartCommand = {
    version: 1,
    kind: 'start',
    commandID: crypto.randomUUID(),
    threadID,
    runID: crypto.randomUUID().toLowerCase(),
    input: { messageID: crypto.randomUUID(), text: 'Hello' },
  }
  expect(await acceptExecutionCommand(db, startCommandSchema.parse(command))).toBe('accepted')
  const lease = await claimExecutionRun(db, { ownerID: crypto.randomUUID(), leaseMs: 60000 })
  if (lease === null) throw new Error('Expected a queued lease')
  // Never complete an unrelated fixture's globally claimed run.
  expect(lease.threadID).toBe(threadID)
  expect(lease.runID).toBe(command.runID)
  return { threadID, lease, writes: bindExecutionWrites(db) }
}

async function completedThread() {
  const { threadID, lease, writes } = await claimedThread()
  expect(await writes.appendText(lease, 'answer')).toBe(true)
  expect(await writes.complete(lease, { text: 'answer' })).toBe('completed')
  return threadID
}

async function eventsFor(threadID: string) {
  return await db
    .selectFrom('execution.event_outbox')
    .select(['event_id', 'ordinal', 'published_at', 'event'])
    .where('thread_id', '=', threadID)
    .orderBy('ordinal')
    .execute()
}

test('sweep preserves explicitly aged unpublished evidence and recent publications', async () => {
  const threadID = await completedThread()
  const events = await eventsFor(threadID)
  expect(events.length).toBeGreaterThanOrEqual(3)
  const [aged, recent, unpublished] = events
  if (!aged || !recent || !unpublished) throw new Error('Expected three retained events')
  await db
    .updateTable('execution.event_outbox')
    .set({ published_at: sql`clock_timestamp() - interval '40 days'` })
    .where('event_id', '=', aged.event_id)
    .execute()
  await db
    .updateTable('execution.event_outbox')
    .set({ published_at: sql`clock_timestamp()` })
    .where('event_id', '=', recent.event_id)
    .execute()
  await db
    .updateTable('execution.event_outbox')
    .set({ created_at: sql`clock_timestamp() - interval '40 days'` })
    .where('event_id', '=', unpublished.event_id)
    .execute()
  await sweepPublishedEvents(db, retentionMs)
  const remaining = await eventsFor(threadID)
  expect(remaining.some((row) => row.event_id === aged.event_id)).toBe(false)
  expect(remaining.find((row) => row.event_id === recent.event_id)?.published_at).toBeInstanceOf(
    Date,
  )
  expect(remaining.find((row) => row.event_id === unpublished.event_id)?.published_at).toBeNull()
})

test('sweep cannot erase an active run ordinal before its next native append', async () => {
  const { threadID, lease, writes } = await claimedThread()
  expect(await writes.appendText(lease, 'first')).toBe(true)
  const before = await eventsFor(threadID)
  expect(before.map((event) => event.ordinal)).toEqual([1, 2])
  await db
    .updateTable('execution.event_outbox')
    .set({ published_at: sql`clock_timestamp() - interval '40 days'` })
    .where('thread_id', '=', threadID)
    .execute()
  await sweepPublishedEvents(db, 1)
  expect(await writes.appendText(lease, 'second')).toBe(true)
  expect((await eventsFor(threadID)).map((event) => event.ordinal)).toEqual([1, 2, 3])
  expect(await writes.cancel(lease)).toBe('cancelled')
})

test('one sweep has a bounded deletion batch even with a terminal backlog', async () => {
  const threadID = await completedThread()
  const events = await eventsFor(threadID)
  const template = events[0]
  if (!template) throw new Error('Expected a completed run event')
  const row = await db
    .selectFrom('execution.runs')
    .select('run_id')
    .where('thread_id', '=', threadID)
    .executeTakeFirstOrThrow()
  const values = Array.from({ length: 300 }, (_, index) => {
    const eventID = crypto.randomUUID()
    return {
      event_id: eventID,
      thread_id: threadID,
      run_id: row.run_id,
      ordinal: 1000 + index,
      event: sql<
        typeof template.event
      >`${JSON.stringify(template.event)}::jsonb || jsonb_build_object('eventID', ${eventID}::text)`,
      published_at: sql<Date>`clock_timestamp() - interval '40 days'`,
    }
  })
  await db.insertInto('execution.event_outbox').values(values).execute()
  const deleted = await sweepPublishedEvents(db, retentionMs)
  expect(deleted).toBeGreaterThan(0)
  expect(deleted).toBeLessThanOrEqual(128)
  expect((await eventsFor(threadID)).length).toBeGreaterThan(events.length)
})
