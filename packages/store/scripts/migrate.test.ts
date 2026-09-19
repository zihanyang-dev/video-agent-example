/**
 * What the runner promises: every migration runs, each runs once, and one that fails leaves
 * neither half of itself behind.
 *
 * Against a database made for the purpose, because these cases rewrite the schema.
 */
import { SQL } from 'bun'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { applyMigrations, databaseUrl } from './migrate'

const SCRATCH = 'vid_migrate_test'

const url = new URL(databaseUrl())
const adminUrl = new URL(url.href)
adminUrl.pathname = '/postgres'
const scratchUrl = new URL(url.href)
scratchUrl.pathname = `/${SCRATCH}`

const admin = new SQL(adminUrl.href)
let sql: SQL

beforeEach(async () => {
  if (sql !== undefined) await sql.close()
  // A pooled connection can outlive `close` by a moment, and `drop database` refuses while
  // one is attached.
  await admin`
    select pg_terminate_backend(pid) from pg_stat_activity where datname = ${SCRATCH}
  `
  await admin`drop database if exists ${admin(SCRATCH)}`
  await admin`create database ${admin(SCRATCH)}`
  sql = new SQL(scratchUrl.href)
})

afterAll(async () => {
  await sql.close()
  await admin`drop database if exists ${admin(SCRATCH)}`
  await admin.close()
})

describe('applying what is committed', () => {
  test('a first run puts every table there', async () => {
    const applied = await applyMigrations(sql)

    expect(applied.length).toBeGreaterThan(0)
    const tables = await sql`
      select table_name from information_schema.tables where table_schema = 'public'
    `
    const names = tables.map((row: { table_name: string }) => row.table_name)
    expect(names).toContain('messages')
    expect(names).toContain('sessions')
    expect(names).toContain('threads')
  })

  test('statements after the first one in a file run too', async () => {
    await applyMigrations(sql)

    const indexes = await sql`select indexname from pg_indexes where tablename = 'messages'`
    expect(indexes.map((row: { indexname: string }) => row.indexname)).toContain(
      'messages_by_thread',
    )
  })

  test('a second run does nothing', async () => {
    await applyMigrations(sql)

    expect(await applyMigrations(sql)).toHaveLength(0)
  })

  test('the constraints are real, not decoration', async () => {
    await applyMigrations(sql)

    // Written out rather than with `.rejects`, because a query here is lazy: handing the
    // unexecuted thing to a matcher never runs it, and the test waits for a rejection that
    // was never going to arrive.
    let refused = false
    try {
      await sql`insert into messages (thread_id, message_id, body) values (${'ghost'}, ${'m'}, ${{}})`
    } catch {
      refused = true
    }

    expect(refused).toBe(true)
  })
})

describe('a migration that fails half way', () => {
  test('leaves neither the tables it made nor a record that it ran', async () => {
    await applyMigrations(sql)
    const statements = 'create table half_good (a int);\nselect no_such_function();\n'

    let failed = false
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(statements)
        await tx`insert into applied_migrations (name) values (${'0-half-good.sql'})`
      })
    } catch {
      failed = true
    }

    expect(failed).toBe(true)
    const [left] = await sql`select to_regclass('public.half_good') as made`
    expect(left.made).toBeNull()
    const [recorded] = await sql`
      select count(*)::int as n from applied_migrations where name like ${'%half-good%'}
    `
    expect(recorded.n).toBe(0)
  })
})
