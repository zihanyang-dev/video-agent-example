import type { DB } from '../generated/db'
import { Kysely, PostgresDialect } from 'kysely'
import { DatabaseError, Pool } from 'pg'

/** Process owners retain the database until HTTP, turns and background tasks settle. */
export function openDatabase(
  connections: Readonly<{ DATABASE_URL: string; IO_TIMEOUT_MS: number }>,
  onError: (error: unknown) => void,
): Kysely<DB> {
  const pool = new Pool({
    connectionString: connections.DATABASE_URL,
    max: 8,
    connectionTimeoutMillis: connections.IO_TIMEOUT_MS,
    // Client response budget only: query_timeout does not cancel remote SQL.
    // URL/startup-option precedence is the operator's configuration responsibility.
    query_timeout: connections.IO_TIMEOUT_MS * 2,
    statement_timeout: connections.IO_TIMEOUT_MS,
    lock_timeout: connections.IO_TIMEOUT_MS,
    idle_in_transaction_session_timeout: connections.IO_TIMEOUT_MS,
  })
  pool.on('error', onError)
  // pg-pool handles idle errors; checked-out clients also emit error events.
  pool.on('connect', (client) => client.on('error', onError))
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    log(event) {
      // SQL errors can roll back normally. An unknown query transport outcome
      // must notify the process owner to stop intake, not retry uncertain work.
      if (event.level === 'error' && !(event.error instanceof DatabaseError))
        onError(event.error)
    },
  })
}
