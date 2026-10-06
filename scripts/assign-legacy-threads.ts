import { readAdministrationEnv, type AdministrationEnv } from '@vid/config'
import { openDatabase } from '@vid/database/connection'
import {
  assignLegacyThreads,
  legacyAssignmentsSchema,
} from '../apps/server/src/db/legacy-thread-ownership'

// Explicit administrator input only. No DDL, user creation, deletion, or first
// login claim. Run against the reviewed database with an administrative role.
export async function assignReviewedLegacyThreads(
  path: string,
  connections: AdministrationEnv,
) {
  const assignments = legacyAssignmentsSchema.parse(await Bun.file(path).json())
  const failures: unknown[] = []
  const db = openDatabase(connections, (cause) => failures.push(cause))
  const [operation] = await Promise.allSettled([
    assignLegacyThreads(db, assignments),
  ])
  const [cleanup] = await Promise.allSettled([db.destroy()])
  if (operation.status === 'rejected') failures.unshift(operation.reason)
  if (cleanup.status === 'rejected') failures.push(cleanup.reason)
  const causes = [...new Set(failures)]
  if (causes.length > 1)
    throw new AggregateError(
      causes,
      'Legacy assignment or database settlement failed',
    )
  if (operation.status === 'rejected') throw operation.reason
  if (causes.length === 1) throw causes[0]
  return operation.value
}

if (import.meta.main) {
  const path = process.argv[2]
  if (!path || process.argv.length !== 3)
    throw new Error(
      'Usage: bun scripts/assign-legacy-threads.ts reviewed-assignments.json',
    )
  console.log(await assignReviewedLegacyThreads(path, readAdministrationEnv()))
}
