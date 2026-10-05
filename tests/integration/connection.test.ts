import { expect, test } from 'bun:test'
import { readMigrationEnv } from '@vid/config'
import { openDatabase } from '@vid/database/connection'
import { sql } from 'kysely'
import { openTestDatabase } from './database-fixture'
import { postgresProxy, eventually } from './postgres-proxy-fixture'

test('SQL read deadline destroys the socket and immediately reconnects only database transport', async () => {
  const proxy = await postgresProxy(readMigrationEnv().DATABASE_URL)
  const db = openDatabase(
    { DATABASE_URL: proxy.databaseURL, IO_TIMEOUT_MS: 200 },
    () => {},
  )
  try {
    const initial = await sql<{
      pid: number
    }>`select pg_backend_pid() as pid`.execute(db)
    proxy.blackhole()
    const started = Date.now()
    const failure = await sql`select 2`.execute(db).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error('Expected native deadline')
    expect(failure.constructor).toBe(Error)
    expect(failure.message).toBe('Query read timeout')
    expect('code' in failure).toBe(false)
    expect(Date.now() - started).toBeLessThan(1500)
    // Reconnect before observing close: a timed-out client must never be
    // handed out again, even in the release/acquire race.
    proxy.restore()
    const replacement = await sql<{
      pid: number
    }>`select pg_backend_pid() as pid`.execute(db)
    expect(replacement.rows[0]?.pid).not.toBe(initial.rows[0]?.pid)
    expect(proxy.connections).toBe(2)
    await eventually(() => proxy.closedClients === 1)
    expect(proxy.closedClients).toBe(1)
  } finally {
    await db.destroy()
    await proxy.close()
  }
}, 10000)

test('lost COMMIT response reports failure without replaying a committed write', async () => {
  const proxy = await postgresProxy(readMigrationEnv().DATABASE_URL)
  const db = openDatabase(
    { DATABASE_URL: proxy.databaseURL, IO_TIMEOUT_MS: 200 },
    () => {},
  )
  const observer = openTestDatabase()
  const table = sql.id(
    `connection_fixture_${crypto.randomUUID().replaceAll('-', '')}`,
  )
  let attempts = 0
  try {
    await sql`create table ${table} (value integer not null)`.execute(
      observer.db,
    )
    const failure = await db
      .transaction()
      .execute(async (trx) => {
        attempts++
        await sql`insert into ${table} values (1)`.execute(trx)
        // COMMIT reaches real PG, but neither its reply nor rollback's can reach
        // the caller. Failure is unknown, not proof of non-commit.
        proxy.blackhole()
      })
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(failure).toBeInstanceOf(Error)
    expect(attempts).toBe(1)
    const rows = await sql<{
      value: number
    }>`select value from ${table}`.execute(observer.db)
    expect(rows.rows).toEqual([{ value: 1 }])
    await eventually(() => proxy.closedClients === 1)
    expect(proxy.closedClients).toBe(1)
  } finally {
    await db.destroy()
    await proxy.close()
    await sql`drop table if exists ${table}`.execute(observer.db)
    await observer.close()
  }
}, 10000)

test('ordinary business and SQL failures rollback without replacing the error or discarding the connection', async () => {
  const db = openDatabase(
    { DATABASE_URL: readMigrationEnv().DATABASE_URL, IO_TIMEOUT_MS: 200 },
    () => {},
  )
  try {
    const initial = await sql<{
      pid: number
    }>`select pg_backend_pid() as pid`.execute(db)
    const businessError = new Error('fixture-owner-conflict')
    const businessFailure = await db
      .transaction()
      .execute(async (trx) => {
        await sql`select 1`.execute(trx)
        throw businessError
      })
      .catch((error: unknown) => error)
    expect(businessFailure).toBe(businessError)
    const sqlFailure = await db
      .transaction()
      .execute(async (trx) => {
        await sql`select 'invalid'::integer`.execute(trx)
      })
      .catch((error: unknown) => error)
    expect(sqlFailure).toHaveProperty('code', '22P02')
    const timedOut = await db
      .transaction()
      .execute(async (trx) => {
        await sql`select pg_sleep(5)`.execute(trx)
      })
      .catch((error: unknown) => error)
    expect(timedOut).toHaveProperty('code', '57014')
    const after = await sql<{
      pid: number
    }>`select pg_backend_pid() as pid`.execute(db)
    expect(after.rows[0]?.pid).toBe(initial.rows[0]?.pid)
  } finally {
    await db.destroy()
  }
}, 10000)
