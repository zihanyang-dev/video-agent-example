import { afterAll, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { createHTTP } from '../../apps/server/src/http'
import { acceptExecutionEvent } from '../../apps/server/src/db/execution-events'
import { archiveThread } from '../../apps/server/src/db/cancellations'
import { acceptMessageIntent } from '../../apps/server/src/db/submissions'
import {
  createOwnedThread,
  snapshotOwnedMessages,
} from '../../apps/server/src/db/conversations'
import { assignLegacyThreads } from '../../apps/server/src/db/legacy-thread-ownership'
import { openTestDatabase } from './database-fixture'
import { signedTestIdentity } from './authentication-fixture'

const { db, close } = openTestDatabase(8)
const login = await signedTestIdentity(db)
const foreign = await signedTestIdentity(db)
const shutdown = new AbortController()
const route = createHTTP(db, {
  authentication: login.authentication,
  signal: shutdown.signal,
  pollIntervalMs: 5,
})
const threadIDs: string[] = []
afterAll(async () => {
  shutdown.abort()
  for (const table of [
    'product.execution_events',
    'product.command_outbox',
    'product.messages',
    'product.threads',
  ] as const) {
    if (threadIDs.length)
      await db.deleteFrom(table).where('thread_id', 'in', threadIDs).execute()
  }
  await db
    .deleteFrom('auth.user')
    .where('id', 'in', [login.user.id, foreign.user.id])
    .execute()
  await close()
})
function request(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  headers = login.headers,
) {
  return route(
    new Request(`http://127.0.0.1:8787/api${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}
async function ownedThread() {
  const query = { ownerID: login.user.id, threadID: crypto.randomUUID() }
  await createOwnedThread(db, { ...query, title: 'Original title' })
  threadIDs.push(query.threadID)
  return query
}
function intent(query: Awaited<ReturnType<typeof ownedThread>>) {
  return {
    ...query,
    messageID: crypto.randomUUID(),
    commandID: crypto.randomUUID(),
    runID: crypto.randomUUID(),
    text: 'hello',
  }
}
function observation(threadID: string, runID: string) {
  return {
    threadId: threadID,
    runId: runID,
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  }
}

test('HTTP thread retry, title, archive and authenticated ownership are the only product scope', async () => {
  const threadID = crypto.randomUUID()
  threadIDs.push(threadID)
  const creation = { threadID, title: 'Chat title' }
  expect((await request('/threads', creation)).status).toBe(201)
  expect(
    (await request(`/threads/${threadID}`, { title: 'Renamed' }, 'PATCH'))
      .status,
  ).toBe(200)
  expect((await request('/threads', creation)).status).toBe(200)
  expect(
    (await request('/threads', { ...creation, title: 'Conflicting' })).status,
  ).toBe(409)
  expect(
    (await request('/threads', { ...creation, userID: foreign.user.id }))
      .status,
  ).toBe(400)
  expect(
    (await request(`/threads/${threadID}`, undefined, 'GET', new Headers()))
      .status,
  ).toBe(401)
  expect(
    (await request(`/threads/${threadID}`, undefined, 'GET', foreign.headers))
      .status,
  ).toBe(404)
  expect(
    (await request('/threads', creation, 'POST', foreign.headers)).status,
  ).toBe(404)
  expect((await request(`/threads/${threadID}/archive`, {})).status).toBe(200)
  expect(
    (await request(`/threads/${threadID}`, { title: 'Cannot rename' }, 'PATCH'))
      .status,
  ).toBe(409)
  expect(
    (
      await request(`/threads/${threadID}/messages`, {
        messageID: crypto.randomUUID(),
        text: 'late',
      })
    ).status,
  ).toBe(409)
  expect(await (await request(`/threads/${threadID}/messages`)).json()).toEqual(
    { messages: [], activeRuns: [], failedRuns: [] },
  )
})

test('archive requests stopping and keeps durable accepted work active until a real terminal', async () => {
  const query = await ownedThread()
  const submission = intent(query)
  expect((await acceptMessageIntent(db, submission)).kind).toBe('accepted')
  await archiveThread(db, query)
  await archiveThread(db, query)
  expect((await snapshotOwnedMessages(db, query))?.activeRuns).toEqual([
    {
      runID: submission.runID,
      messageID: submission.messageID,
      status: 'stopping',
    },
  ])
  expect(
    await db
      .selectFrom('product.command_outbox')
      .select('command_id')
      .where('thread_id', '=', query.threadID)
      .execute(),
  ).toHaveLength(2)
  expect((await acceptMessageIntent(db, submission)).kind).toBe('conflict')
  await acceptExecutionEvent(db, {
    ordinal: 1,
    event: {
      version: 1,
      kind: 'run-cancelled',
      eventID: crypto.randomUUID(),
      threadID: query.threadID,
      runID: submission.runID,
    },
  })
  expect((await snapshotOwnedMessages(db, query))?.activeRuns).toEqual([])
})

async function threadBarrier(threadID: string) {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const locked = new Promise<void>((resolve) => {
    entered = resolve
  })
  const done = db.transaction().execute(async (tx) => {
    await tx
      .selectFrom('product.threads')
      .select('thread_id')
      .where('thread_id', '=', threadID)
      .forUpdate()
      .execute()
    entered()
    await waiting
  })
  await locked
  return { release, done }
}
async function waitForBlockedThreadWriters(count: number) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const blocked = await sql<{
      count: number
    }>`select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%product%threads%for update%'`.execute(
      db,
    )
    if ((blocked.rows[0]?.count ?? 0) >= count) return
    await Bun.sleep(5)
  }
  throw new Error('Expected blocked thread writers')
}

test('real PG barrier serializes archive against send and exact replay under the thread lock', async () => {
  const query = await ownedThread()
  const accepted = intent(query)
  await acceptMessageIntent(db, accepted)
  const barrier = await threadBarrier(query.threadID)
  try {
    const archiving = archiveThread(db, query)
    await waitForBlockedThreadWriters(1)
    const sending = acceptMessageIntent(db, intent(query))
    const replaying = acceptMessageIntent(db, accepted)
    await waitForBlockedThreadWriters(3)
    barrier.release()
    await barrier.done
    await archiving
    expect((await sending).kind).toBe('conflict')
    expect((await replaying).kind).toBe('conflict')
    expect((await snapshotOwnedMessages(db, query))?.messages).toHaveLength(1)
  } finally {
    barrier.release()
    await barrier.done
  }
})

test.each(['expiry', 'logout', 'revocation'] as const)(
  'open SSE stops future reads after session %s but does not abort accepted work',
  async (kind) => {
    const identity = await signedTestIdentity(db)
    const query = { ownerID: identity.user.id, threadID: crypto.randomUUID() }
    threadIDs.push(query.threadID)
    await createOwnedThread(db, { ...query, title: 'Session lifetime' })
    const submission = intent(query)
    await acceptMessageIntent(db, submission)
    const local = createHTTP(db, {
      authentication: identity.authentication,
      signal: shutdown.signal,
      pollIntervalMs: 5,
    })
    const response = await local(
      new Request(
        `http://127.0.0.1:8787/api/threads/${query.threadID}/runs/${submission.runID}/events`,
        {
          method: 'POST',
          headers: identity.headers,
          body: JSON.stringify(observation(query.threadID, submission.runID)),
        },
      ),
    )
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      'RUN_STARTED',
    )
    await endSession(kind, identity, local)
    await acceptExecutionEvent(db, {
      ordinal: 1,
      event: {
        version: 1,
        kind: 'assistant-text',
        eventID: crypto.randomUUID(),
        messageID: crypto.randomUUID(),
        threadID: query.threadID,
        runID: submission.runID,
        delta: 'private after logout',
      },
    })
    expect((await reader.read()).done).toBe(true)
    expect((await snapshotOwnedMessages(db, query))?.activeRuns).toHaveLength(1)
  },
)

test('legacy assignment rejects unknown users atomically without changing IDs or history', async () => {
  const query = await ownedThread()
  // Deliberately matches a real user ID: coincidence still cannot assign it.
  const legacyOwnerID = login.user.id
  const submission = intent(query)
  await acceptMessageIntent(db, submission)
  await restoreUnmappedLegacyFixture(query.threadID, legacyOwnerID)
  try {
    expect((await request('/session')).status).toBe(200)
    expect((await request('/threads')).status).toBe(503)
    const rejected = await assignLegacyThreads(db, [
      { legacyOwnerID, userID: 'not-a-library-user' },
    ]).then(
      () => null,
      (cause: unknown) => cause,
    )
    expect(String(rejected)).toContain('unknown authentication user')
    expect(
      (
        await db
          .selectFrom('product.threads')
          .select('owner_id')
          .where('thread_id', '=', query.threadID)
          .executeTakeFirstOrThrow()
      ).owner_id,
    ).toBeNull()
    expect(
      await assignLegacyThreads(db, [{ legacyOwnerID, userID: login.user.id }]),
    ).toEqual({ assigned: 1 })
    expect(
      await assignLegacyThreads(db, [{ legacyOwnerID, userID: login.user.id }]),
    ).toEqual({ assigned: 0 })
    expect((await request(`/threads/${query.threadID}`)).status).toBe(200)
    expect(
      (await snapshotOwnedMessages(db, query))?.messages[0]?.messageID,
    ).toBe(submission.messageID)
    expect((await snapshotOwnedMessages(db, query))?.activeRuns[0]?.runID).toBe(
      submission.runID,
    )
  } finally {
    await db
      .updateTable('product.threads')
      .set({ owner_id: login.user.id })
      .where('thread_id', '=', query.threadID)
      .execute()
  }
})

async function endSession(
  kind: 'expiry' | 'revocation' | 'logout',
  identity: Awaited<ReturnType<typeof signedTestIdentity>>,
  local: ReturnType<typeof createHTTP>,
) {
  if (kind === 'expiry')
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', identity.session.id)
      .execute()
  if (kind === 'revocation')
    await db
      .deleteFrom('auth.session')
      .where('id', '=', identity.session.id)
      .execute()
  if (kind === 'logout')
    expect(
      (
        await local(
          new Request('http://127.0.0.1:8787/api/logout', {
            method: 'POST',
            headers: identity.headers,
            body: '{}',
          }),
        )
      ).status,
    ).toBe(200)
}

test('foreign cancellation command IDs cannot reveal conflicts in another user history', async () => {
  const query = await ownedThread()
  const ownRun = intent(query)
  await acceptMessageIntent(db, ownRun)
  const otherQuery = { ownerID: foreign.user.id, threadID: crypto.randomUUID() }
  threadIDs.push(otherQuery.threadID)
  await createOwnedThread(db, { ...otherQuery, title: 'Private' })
  const otherRun = intent(otherQuery)
  await acceptMessageIntent(db, otherRun)
  expect(
    (
      await request(`/threads/${query.threadID}/runs/${ownRun.runID}/cancel`, {
        commandID: otherRun.commandID,
      })
    ).status,
  ).toBe(404)
  expect((await snapshotOwnedMessages(db, query))?.activeRuns[0]?.status).toBe(
    'accepted',
  )
})

async function restoreUnmappedLegacyFixture(
  threadID: string,
  legacyOwnerID: string,
) {
  // Simulate a row that existed before the forward migration in this ephemeral
  // test database. Restoring NOT VALID is the actual migration's enforcement.
  await db.transaction().execute(async (tx) => {
    await sql`alter table product.threads drop constraint thread_requires_identity`.execute(
      tx,
    )
    await tx
      .updateTable('product.threads')
      .set({ owner_id: null, legacy_owner_id: legacyOwnerID })
      .where('thread_id', '=', threadID)
      .execute()
    await sql`alter table product.threads add constraint thread_requires_identity check (owner_id is not null) not valid`.execute(
      tx,
    )
  })
}
