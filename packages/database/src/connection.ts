import type { DB } from '../generated/db'
import { Kysely, PostgresDialect, type PostgresPoolClient } from 'kysely'
import { Pool, type PoolClient } from 'pg'

/** Shared SQL transport ownership, not product or execution authority. Process
 * owners retain the database until their HTTP, turns and background tasks settle.
 */
export function openDatabase(
  connections: Readonly<{ DATABASE_URL: string; IO_TIMEOUT_MS: number }>,
  onError: (error: unknown) => void,
): Kysely<DB> {
  const pool = new Pool({
    connectionString: connections.DATABASE_URL,
    max: 8,
    connectionTimeoutMillis: connections.IO_TIMEOUT_MS,
    // Server execution budget plus a response budget for unreachable transport.
    query_timeout: connections.IO_TIMEOUT_MS * 2,
    statement_timeout: connections.IO_TIMEOUT_MS,
    lock_timeout: connections.IO_TIMEOUT_MS,
    idle_in_transaction_session_timeout: connections.IO_TIMEOUT_MS,
  })
  pool.on('error', onError)
  // Kysely caches connection identity: retain one owner per physical pooled client.
  const clients = new WeakMap<PoolClient, PostgresPoolClient>()
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: {
        options: pool.options,
        end: () => pool.end(),
        async connect() {
          const client = await pool.connect()
          // Checked-out transport failures are not handled by pg-pool's idle listener.
          client.on('error', onError)
          let owned = clients.get(client)
          if (!owned) {
            owned = ownClient(client, onError)
            clients.set(client, owned)
          }
          return owned
        },
      },
    }),
  })
}

/** Kysely's external client owns this native resource, not a detached timeout race.
 * pg 8.23's non-pipelined query_timeout rejects without closing an active query.
 * Its public end() destroys an active query's socket and awaits connection end.
 */
function ownClient(
  client: PoolClient,
  onError: (error: unknown) => void,
): PostgresPoolClient {
  let deadline: Error | undefined
  // Retain the SDK's overloaded signature without copying it. This dialect has
  // no cursor configured; Kysely calls only the text/parameters query contract.
  const nativeQuery: PostgresPoolClient['query'] = client.query.bind(client)
  const query = new Proxy(nativeQuery, {
    apply(target, _receiver: unknown, args: unknown[]) {
      if (deadline) return Promise.reject(deadline)
      // Preserve native overload dispatch instead of revalidating typed callers.
      const receipt: unknown = Reflect.apply(target, client, args)
      if (!(receipt instanceof Promise)) return receipt
      return receipt.catch(async (error: unknown) => {
        // pg has no exported read-timeout subtype or code. This is its exact
        // native Error shape, distinct from PostgreSQL DatabaseError codes.
        if (
          error instanceof Error &&
          error.constructor === Error &&
          error.message === 'Query read timeout' &&
          !('code' in error)
        ) {
          deadline = error
          await client.end()
        }
        throw error
      })
    },
  })
  return {
    query,
    // Never return a deadline-expired physical connection to the idle pool.
    // Normal SQL/business failures leave it usable for Kysely's ROLLBACK.
    release: () => {
      client.removeListener('error', onError)
      client.release(deadline !== undefined)
    },
  }
}
