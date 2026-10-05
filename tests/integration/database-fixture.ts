import { readMigrationEnv } from '@vid/config'
import type { DB } from '@vid/database/types'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

export function openTestDatabase(max = 4) {
  const env = readMigrationEnv()
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: env.DATABASE_URL, max }),
    }),
  })
  return { db, close: () => db.destroy() }
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
