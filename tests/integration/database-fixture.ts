import { readMigrationEnv } from '@vid/config'
import type { DB } from '@vid/database/types'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type ClientBase } from 'pg'

/** Launcher-issued capability: the unpredictable token must match metadata on
 * the actual connected database, not a caller's URL/name assertion. */
export function testDatabaseOptions(connectionString: string) {
  const owner = process.env.VID_TEST_DATABASE_OWNER
  if (!owner || !/^[a-f0-9]{64}$/.test(owner))
    throw new Error('Owned test database required')
  return {
    connectionString,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    statement_timeout: 5000,
    lock_timeout: 5000,
    idle_in_transaction_session_timeout: 5000,
  }
}

export async function verifyTestDatabase(
  client: ClientBase,
  owner = process.env.VID_TEST_DATABASE_OWNER,
) {
  if (!owner || !/^[a-f0-9]{64}$/.test(owner))
    throw new Error('Owned test database required')
  const result = await client.query<{ marker: string | null }>(
    "select shobj_description(oid, 'pg_database') as marker from pg_database where datname = current_database()",
  )
  if (result.rows[0]?.marker !== `vid-test-database:${owner}`)
    throw new Error('Owned test database required')
}

export function openTestDatabase(
  max = 4,
  connectionString = readMigrationEnv().DATABASE_URL,
) {
  const options = testDatabaseOptions(connectionString)
  const owner = process.env.VID_TEST_DATABASE_OWNER
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({
      // Native lazy callback preserves synchronous {db, close} callers without
      // creating a resource before an owner can register its cleanup.
      pool: async () => {
        const pool = new Pool({
          ...options,
          max,
          verify(client, done) {
            // Native pg admission runs before it returns any new pooled client.
            void verifyTestDatabase(client, owner).then(
              () => done(),
              () => done(new Error('Owned test database required')),
            )
          },
        })
        pool.on('error', () => {})
        pool.on('connect', (client) => client.on('error', () => {}))
        return pool
      },
    }),
  })
  const close = () => db.destroy()
  return { db, close }
}

/** Attempt every owned cleanup even when an earlier SQL deletion fails. */
export async function settleTestCleanup(cleanups: (() => Promise<unknown>)[]) {
  const failures: unknown[] = []
  for (const cleanup of cleanups) {
    try {
      await cleanup()
    } catch (cause) {
      failures.push(cause)
    }
  }
  if (failures.length)
    throw new AggregateError(failures, 'Test database cleanup failed')
}

/** Direct SQL tests may use symbolic IDs, but must still seed actual library
 * users. This is setup only, not an HTTP identity or cookie bypass. */
export async function seedTestUser(db: Kysely<DB>, userID: string) {
  await db
    .insertInto('auth.user')
    .values({
      id: userID,
      name: 'Test user',
      emailVerified: true,
      email: `${encodeURIComponent(userID)}@fixture.example`,
      updatedAt: new Date(),
    })
    .onConflict((c) => c.column('id').doNothing())
    .execute()
}
