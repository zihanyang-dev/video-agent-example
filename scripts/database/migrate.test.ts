import { expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { createTestDatabase } from '../../tests/fixtures/database'
import { applyMigrations } from './migrate'

test('legacy conversations, artifact keys and model history survive the ownership migration', async () => {
  const database = await createTestDatabase(seedLegacyConversation)

  try {
    await assertLegacyRecords(database)
  } finally {
    await database.close()
  }
})

/** Seed the original schema before the fixture applies the ownership migrations. */
const seedLegacyConversation = async (sql: SQL): Promise<void> => {
  const migration = new URL(
    '../../apps/server/migrations/20260919103000-threads-messages-sessions.sql',
    import.meta.url,
  )
  await sql.unsafe(await Bun.file(migration).text())
  await sql`
    create table public.applied_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `
  await sql`
    insert into public.applied_migrations (name)
    values ('20260919103000-threads-messages-sessions.sql')
  `

  const answer = { id: 'text', role: 'assistant', content: 'Ready' }
  const artifact = {
    id: 'video',
    role: 'activity',
    activityType: 'artifact',
    content: { key: 'threads/legacy/final.mp4', role: 'final' },
  }
  await sql`insert into threads (thread_id, user_id) values ('legacy', 'owner')`
  await sql`
    insert into messages (thread_id, message_id, body)
    values ('legacy', 'text', ${answer}), ('legacy', 'video', ${artifact})
  `
  await sql`
    insert into sessions (thread_id, entries)
    values ('legacy', ${[{ type: 'message', id: 'entry' }]})
  `
}

const assertLegacyRecords = async (database: Awaited<ReturnType<typeof createTestDatabase>>) => {
  const messages = await database.product`select body from product.messages order by seq`
  expect(messages[0].body).toEqual({
    id: 'text',
    kind: 'text',
    author: 'assistant',
    text: 'Ready',
    finished: true,
  })
  expect(messages[1].body).toEqual({
    id: 'video',
    kind: 'activity',
    activity: { kind: 'artifact', key: 'threads/legacy/final.mp4', role: 'final' },
  })

  const [session] = await database.execution`
    select entries, workspace from execution.sessions where thread_id = 'legacy'
  `
  expect(session.entries).toEqual([{ type: 'message', id: 'entry' }])
  expect(session.workspace).toBe('threads/legacy/')

  expect(await applyMigrations(database.sql)).toEqual([])

  await database.product`delete from product.threads where thread_id = 'legacy'`
  expect(await database.execution`select thread_id from execution.sessions`).toHaveLength(1)
}
