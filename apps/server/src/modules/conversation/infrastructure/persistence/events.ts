import type { SQL } from 'bun'
import type { Change } from '../../domain/message'

/**
 * Must share the transaction that changes the public projection. A cursor describes
 * committed conversation state, not an independently published transport position.
 */
export const appendChange = async (sql: SQL, threadID: string, change: Change): Promise<void> => {
  const [thread] = await sql`
    update product.threads
    set revision = revision + 1
    where thread_id = ${threadID}
    returning revision
  `
  await sql`
    insert into product.events (thread_id, cursor, body)
    values (${threadID}, ${thread.revision}, ${change})
  `
}
