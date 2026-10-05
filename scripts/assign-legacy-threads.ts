import { readMigrationEnv } from '@vid/config'
import type { DB } from '@vid/database/types'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import {
  assignLegacyThreads,
  legacyAssignmentsSchema,
} from '../apps/server/src/db/legacy-thread-ownership'

// Explicit administrator input only. No DDL, user creation, deletion, or first
// login claim. Run against the reviewed database with an administrative role.
const path = process.argv[2]
if (!path || process.argv.length !== 3)
  throw new Error(
    'Usage: bun scripts/assign-legacy-threads.ts reviewed-assignments.json',
  )
const assignments = legacyAssignmentsSchema.parse(await Bun.file(path).json())
const db = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: readMigrationEnv().DATABASE_URL }),
  }),
})
try {
  console.log(await assignLegacyThreads(db, assignments))
} finally {
  await db.destroy()
}
