import { readMigrationEnv } from '@vid/config'
import type { DB } from '@vid/database/types'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

export function openTestDatabase() {
  const env = readMigrationEnv()
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: env.DATABASE_URL, max: 4 }),
    }),
  })
  return { db, close: () => db.destroy() }
}
