import { expect, test } from 'bun:test'
import { Client } from 'pg'
import { sql } from 'kysely'
import { readMigrationEnv } from '@vid/config'
import { openTestDatabase, settleTestCleanup } from './database-fixture'

const originalURL = readMigrationEnv().DATABASE_URL
const owner = process.env.VID_TEST_DATABASE_OWNER!

function restore() {
  process.env.DATABASE_URL = originalURL
  process.env.VID_TEST_DATABASE_OWNER = owner
}

test('direct URL without launcher ownership fails before opening a fixture', () => {
  delete process.env.VID_TEST_DATABASE_OWNER
  try {
    expect(() => openTestDatabase()).toThrow('Owned test database required')
  } finally {
    restore()
  }
})

test('actual unmarked target rejects mutation even with the launcher token', async () => {
  const admin = new Client({ connectionString: originalURL })
  const name = `fixture_unmarked_${crypto.randomUUID().replaceAll('-', '')}`
  const table = `fixture_sentinel_${crypto.randomUUID().replaceAll('-', '')}`
  let created = false
  let fixture: ReturnType<typeof openTestDatabase> | undefined
  let target: Client | undefined
  try {
    await admin.connect()
    // Independently admit the launcher's actual target before this test's DDL.
    const proof = await admin.query<{ marker: string }>(
      "select shobj_description(oid, 'pg_database') as marker from pg_database where datname = current_database()",
    )
    expect(proof.rows[0]?.marker).toBe(`vid-test-database:${owner}`)
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
    created = true
    const url = new URL(originalURL)
    url.pathname = `/${name}`
    target = new Client({ connectionString: url.toString() })
    await target.connect()
    await target.query(`CREATE TABLE "${table}" (value integer)`)
    fixture = openTestDatabase(4, url.toString())
    const error = await sql`insert into ${sql.id(table)} values (1)`.execute(fixture.db).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Owned test database required')
    expect((await target.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n).toBe(0)
  } finally {
    restore()
    await settleTestCleanup([
      async () => {
        await fixture?.close()
      },
      async () => {
        await target?.end()
      },
      async () => {
        if (created) await admin.query(`DROP DATABASE "${name}"`)
      },
      () => admin.end(),
    ])
  }
}, 15000)

test('owned fixture exposes native deadlines and closes normally', async () => {
  const fixture = openTestDatabase(1)
  try {
    const result = await sql<{ statement: string; lock: string; idle: string }>`
      select current_setting('statement_timeout') as statement,
        current_setting('lock_timeout') as lock,
        current_setting('idle_in_transaction_session_timeout') as idle
    `.execute(fixture.db)
    expect(result.rows).toEqual([{ statement: '5s', lock: '5s', idle: '5s' }])
  } finally {
    await fixture.close()
  }
})

test('failed SQL cleanup still attempts sibling cleanup and database destroy', async () => {
  const fixture = openTestDatabase()
  let siblingJoined = false
  try {
    const failure = await settleTestCleanup([
      () =>
        sql`select * from ${sql.id(`missing_${crypto.randomUUID().replaceAll('-', '')}`)}`.execute(
          fixture.db,
        ),
      async () => {
        siblingJoined = true
      },
      fixture.close,
    ]).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(siblingJoined).toBe(true)
  } finally {
    await fixture.close()
  }
})

test('statement timeout cancels SQL', async () => {
  const fixture = openTestDatabase()
  const started = performance.now()
  try {
    const failure = await sql`select pg_sleep(30)`.execute(fixture.db).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(failure).toMatchObject({ code: '57014' })
    expect(performance.now() - started).toBeLessThan(9000)
  } finally {
    await fixture.close()
  }
}, 15000)
