import { afterAll, expect, test } from 'bun:test'
import type { ExecutionEvent } from '@vid/contract/execution'
import { sql, type KyselyPlugin } from 'kysely'
import { observeEvents } from '../../apps/server/src/conversation/event-stream'
import {
  acceptExecutionEvent,
  readPublicEvents,
} from '../../apps/server/src/db/execution-events'
import { readOwnedThread } from '../../apps/server/src/db/conversations'
import { acceptMessageIntent } from '../../apps/server/src/db/submissions'
import {
  openTestDatabase,
  seedTestUser,
  settleTestCleanup,
} from './database-fixture'

const { db, close } = openTestDatabase()
const threads: string[] = []
const ownerID = `run-scoped-${crypto.randomUUID()}`
const foreignOwnerID = `run-scoped-foreign-${crypto.randomUUID()}`
afterAll(async () => {
  try {
    await settleTestCleanup([
      ...[
        'product.execution_events',
        'product.command_outbox',
        'product.messages',
        'product.threads',
      ].map((table) => async () => {
        if (!threads.length) return
        // Fixed tables, exact fixture-owned thread scope only.
        await sql`delete from ${sql.table(table)} where thread_id in (${sql.join(threads)})`.execute(
          db,
        )
      }),
      async () => {
        await db
          .deleteFrom('auth.user')
          .where('id', 'in', [ownerID, foreignOwnerID])
          .execute()
      },
    ])
  } finally {
    await close()
  }
})

async function fixture() {
  await seedTestUser(db, ownerID)
  await seedTestUser(db, foreignOwnerID)
  const threadID = crypto.randomUUID()
  const runID = crypto.randomUUID()
  const messageID = crypto.randomUUID()
  await db
    .insertInto('product.threads')
    .values({ thread_id: threadID, owner_id: ownerID })
    .execute()
  threads.push(threadID)
  expect(
    (
      await acceptMessageIntent(db, {
        ownerID,
        threadID,
        runID,
        messageID: crypto.randomUUID(),
        commandID: crypto.randomUUID(),
        text: 'question',
      })
    ).kind,
  ).toBe('accepted')
  async function emit(ordinal: number, event: ExecutionEvent) {
    expect(await acceptExecutionEvent(db, { ordinal, event })).toBe('accepted')
  }
  const base = { version: 1 as const, threadID, runID }
  return {
    ownerID,
    threadID,
    runID,
    start: () =>
      emit(1, { ...base, eventID: crypto.randomUUID(), kind: 'run-started' }),
    text: () =>
      emit(2, {
        ...base,
        eventID: crypto.randomUUID(),
        kind: 'assistant-text',
        messageID,
        delta: 'Hello',
      }),
    finish: () =>
      emit(3, {
        ...base,
        eventID: crypto.randomUUID(),
        kind: 'run-completed',
        messageID,
        text: 'Hello world',
      }),
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function allFacts(f: Fixture) {
  return readPublicEvents(db, { ownerID: f.ownerID, threadID: f.threadID })
}

// Bulk durable replay fixtures avoid measuring ingestion. Each noise run has one
// published fact, preserving native thread/global cursors and uniqueness.
async function noise(f: Fixture, count: number, payloadRunID?: string) {
  if (!count) return
  await sql`
    insert into product.execution_events(event_id, thread_id, run_id, ordinal, payload, processed, replay_cursor)
    select event_id, ${f.threadID}::uuid, run_id, 1,
      jsonb_build_object('version', 1, 'kind', 'run-started', 'eventID', event_id,
        'threadID', ${f.threadID}::text, 'runID', coalesce(${payloadRunID ?? null}::text, run_id::text)),
      true, nextval('product.execution_event_replay_cursor')
    from (select gen_random_uuid() as event_id, gen_random_uuid() as run_id from generate_series(1, ${count})) as facts
  `.execute(db)
}
function measured() {
  let queries = 0
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      return node
    },
    async transformResult({ result }) {
      queries++
      return result
    },
  }
  return { db: db.withPlugin(plugin), count: () => queries }
}
async function observation(f: Fixture, after: string, counted = measured()) {
  const request = new AbortController()
  const process = new AbortController()
  const response = await observeEvents(counted.db, {
    ...f,
    after,
    pollMs: 25,
    requestSignal: request.signal,
    processSignal: process.signal,
    authorize: async () => (await readOwnedThread(counted.db, f)) !== undefined,
  })
  return { response, request, counted }
}
function cursor(text: string) {
  return text
    .match(/^id: (\d+)$/gm)
    ?.at(-1)
    ?.slice(4)
}

// Removing either runID read argument makes these native SQL counts grow with
// unrelated same-thread facts rather than the three target facts.
test.each([0, 301])(
  'live observation uses target-proportional SQL with %s unrelated facts',
  async (count) => {
    const f = await fixture()
    await noise(f, count)
    await f.start()
    await f.text()
    await noise(f, count)
    await f.finish()
    const terminal = (await allFacts(f))?.find(
      (fact) => fact.event.kind === 'run-completed',
    )
    const stream = await observation(f, '0')
    try {
      const text = await stream.response.text()
      expect(text).toContain('"delta":"Hello"')
      expect(text).toContain('"delta":" world"')
      expect(text).toContain('RUN_FINISHED')
      expect(cursor(text)).toBe(terminal?.cursor)
      console.info('live native SQL', {
        noise: count * 2,
        queries: stream.counted.count(),
      })
      expect(stream.counted.count()).toBeLessThanOrEqual(13)
    } finally {
      stream.request.abort()
    }
  },
  60000,
)

test.each([0, 301])(
  'reconnect skips %s unrelated pages and returns the actual historical terminal cursor',
  async (count) => {
    const f = await fixture()
    await noise(f, count)
    await f.start()
    await f.text()
    await f.finish()
    const terminal = (await allFacts(f))?.at(-1)
    await noise(f, count)
    const boundary = (await allFacts(f))?.at(-1)?.cursor
    if (!boundary || !terminal)
      throw new Error('Missing durable fixture cursor')
    const stream = await observation(f, boundary)
    try {
      const text = await stream.response.text()
      expect(text).toContain('RUN_FINISHED')
      expect(cursor(text)).toBe(terminal.cursor)
      expect(text).not.toContain('TEXT_MESSAGE_CONTENT')
      console.info('replay native SQL', {
        noise: count * 2,
        queries: stream.counted.count(),
      })
      expect(stream.counted.count()).toBeLessThanOrEqual(9)
    } finally {
      stream.request.abort()
    }
  },
)

test('optional scope uses stored run_id, retains all-thread reads and enforces owner/thread isolation', async () => {
  const f = await fixture()
  const other = await fixture()
  await f.start()
  await other.start()
  // Deliberately misleading JSON proves the predicate is the stored UUID column.
  await noise(f, 2, f.runID)
  const scopedQuery = {
    ...f,
    runID: f.runID.toUpperCase(),
    threadID: f.threadID.toUpperCase(),
  }
  expect(await readPublicEvents(db, scopedQuery)).toHaveLength(1)
  expect(
    await readPublicEvents(db, { ownerID, threadID: f.threadID }),
  ).toHaveLength(3)
  expect(
    await readPublicEvents(db, { ...scopedQuery, runID: other.runID }),
  ).toEqual([])
  expect(
    await readPublicEvents(db, { ...scopedQuery, threadID: other.threadID }),
  ).toEqual([])
  expect(
    await readPublicEvents(db, { ...scopedQuery, ownerID: foreignOwnerID }),
  ).toBeNull()
})

test('reconstruction retains text before an unrelated-run boundary but does not fold future target facts', async () => {
  const f = await fixture()
  await f.start()
  await f.text()
  await noise(f, 301)
  const boundary = (await allFacts(f))?.at(-1)?.cursor
  await f.finish()
  if (!boundary) throw new Error('Missing boundary')
  const stream = await observation(f, boundary)
  try {
    const text = await stream.response.text()
    expect(text).toContain('"delta":" world"')
    expect(text).not.toContain('"delta":"Hello"')
    expect(text).not.toContain('"delta":"Hello world"')
    expect(text.indexOf('TEXT_MESSAGE_START')).toBeLessThan(
      text.indexOf('TEXT_MESSAGE_CONTENT'),
    )
    expect(text).toContain('RUN_FINISHED')
  } finally {
    stream.request.abort()
  }
})

test.each(['live', 'replay'])(
  'ownership revoked after native %s ledger read emits no further bytes',
  async (mode) => {
    const f = await fixture()
    await f.start()
    await f.text()
    await f.finish()
    const terminal = (await allFacts(f))?.at(-1)?.cursor
    if (!terminal) throw new Error('Missing terminal')
    let ledgerRead = false
    let revoked = false
    let denied = false
    const observed = db.withPlugin({
      transformQuery({ node }) {
        ledgerRead = JSON.stringify(node).includes('execution_events')
        return node
      },
      async transformResult({ result }) {
        if (ledgerRead && !revoked) {
          await db
            .updateTable('product.threads')
            .set({ owner_id: foreignOwnerID })
            .where('thread_id', '=', f.threadID)
            .execute()
          revoked = true
        }
        return result
      },
    })
    const request = new AbortController()
    const response = await observeEvents(observed, {
      ...f,
      after: mode === 'live' ? '0' : terminal,
      pollMs: 25,
      requestSignal: request.signal,
      processSignal: new AbortController().signal,
      authorize: async () => {
        const allowed = (await readOwnedThread(db, f)) !== undefined
        if (revoked && !allowed) denied = true
        return allowed
      },
    })
    try {
      const reader = response.body!.getReader()
      if (mode === 'live') {
        const initial = await reader.read()
        expect(new TextDecoder().decode(initial.value)).toContain('RUN_STARTED')
      }
      // Real reader outcome, not only a canary-string absence.
      expect(await reader.read()).toEqual({ done: true, value: undefined })
      expect(revoked).toBe(true)
      expect(denied).toBe(true)
    } finally {
      request.abort()
    }
  },
)
