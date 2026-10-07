import { expect, test } from 'bun:test'
import { readMigrationEnv } from '@vid/config'
import { openDatabase } from '@vid/database/connection'
import { sql } from 'kysely'
import { openTestDatabase } from './database-fixture'
import { postgresProxy } from './postgres-proxy-fixture'

test('unknown query transport failure notifies the owner without retrying', async () => {
  const proxy = await postgresProxy(readMigrationEnv().DATABASE_URL)
  const failures: unknown[] = []
  const db = openDatabase({ DATABASE_URL: proxy.databaseURL, IO_TIMEOUT_MS: 200 }, (cause) =>
    failures.push(cause),
  )
  try {
    await sql`select 1`.execute(db)
    proxy.blackhole()
    const started = Date.now()
    const failure = await sql`select 2`.execute(db).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(Error)
    expect(failures).toContain(failure)
    expect(Date.now() - started).toBeLessThan(1500)
  } finally {
    await db.destroy()
    await proxy.close()
  }
}, 10000)

test('checked-out connection loss notifies its owner without an unhandled client error', async () => {
  const proxy = await postgresProxy(readMigrationEnv().DATABASE_URL)
  const failures: unknown[] = []
  const db = openDatabase({ DATABASE_URL: proxy.databaseURL, IO_TIMEOUT_MS: 200 }, (cause) =>
    failures.push(cause),
  )
  try {
    const failure = await db
      .connection()
      .execute(async (connection) => {
        await sql`select 1`.execute(connection)
        const query = sql`select pg_sleep(5)`.execute(connection)
        await proxy.close()
        return await query
      })
      .catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(Error)
    expect(failures.length).toBeGreaterThan(0)
  } finally {
    await db.destroy()
  }
}, 10000)

test('lost COMMIT response reports failure without replaying a committed write', async () => {
  const proxy = await postgresProxy(readMigrationEnv().DATABASE_URL)
  const db = openDatabase({ DATABASE_URL: proxy.databaseURL, IO_TIMEOUT_MS: 200 }, () => {})
  const observer = openTestDatabase()
  const table = sql.id(`connection_fixture_${crypto.randomUUID().replaceAll('-', '')}`)
  let attempts = 0
  try {
    await sql`create table ${table} (value integer not null)`.execute(observer.db)
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
  } finally {
    await db.destroy()
    await proxy.close()
    await sql`drop table if exists ${table}`.execute(observer.db)
    await observer.close()
  }
}, 10000)

test('ordinary business and SQL failures rollback without replacing the error or discarding the connection', async () => {
  const url = new URL(readMigrationEnv().DATABASE_URL)
  url.searchParams.set('application_name', 'deadline-owner-fixture')
  url.searchParams.set('options', '-c search_path=pg_catalog')
  const failures: unknown[] = []
  const db = openDatabase({ DATABASE_URL: url.toString(), IO_TIMEOUT_MS: 200 }, (cause) =>
    failures.push(cause),
  )
  try {
    const initial = await sql<{
      pid: number
    }>`select pg_backend_pid() as pid`.execute(db)
    const settings = await sql<{
      application: string
      path: string
      statement: string
      lock: string
      idle: string
    }>`select
      current_setting('application_name') as application,
      current_setting('search_path') as path,
      current_setting('statement_timeout') as statement,
      current_setting('lock_timeout') as lock,
      current_setting('idle_in_transaction_session_timeout') as idle`.execute(db)
    expect(settings.rows).toEqual([
      {
        application: 'deadline-owner-fixture',
        path: 'pg_catalog',
        statement: '200ms',
        lock: '200ms',
        idle: '200ms',
      },
    ])
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
    expect(failures).toEqual([])
  } finally {
    await db.destroy()
  }
}, 10000)
