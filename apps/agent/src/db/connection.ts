import type { WorkerEnv } from '@vid/config'
import type { DB } from '@vid/database/types'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

export type ExecutionDatabase = Kysely<DB>

/** The process retains this connection until all leased execution and sends settle.
 * Bounded queries cannot silently hold shutdown or authority locks forever.
 */
export function openExecutionDatabase(
  connections: Pick<WorkerEnv, 'DATABASE_URL' | 'IO_TIMEOUT_MS'>,
  onError: (error: unknown) => void,
): ExecutionDatabase {
  const pool = new Pool({
    connectionString: connections.DATABASE_URL,
    max: 8,
    connectionTimeoutMillis: connections.IO_TIMEOUT_MS,
    statement_timeout: connections.IO_TIMEOUT_MS,
    lock_timeout: connections.IO_TIMEOUT_MS,
    idle_in_transaction_session_timeout: connections.IO_TIMEOUT_MS,
  })
  pool.on('error', onError)
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) })
}
