/**
 * The agent's own record, on Postgres.
 *
 * One row per thread, replaced whole. The harness hands back its entire history each turn
 * and we do not interpret it, so there is nothing to append to and nothing to diff.
 *
 * Measured: a four-message conversation is 1658 bytes. A long one is larger but still one
 * value, which is why it is a column rather than a table of entries -- a table would invite
 * reading part of it, and no part of it means anything alone.
 */
import type { SQL } from 'bun'
import type { Sessions } from './sessions'

export const createPostgresSessions = (sql: SQL): Sessions => ({
  read: async (threadID) => {
    const [row] = await sql`select entries from sessions where thread_id = ${threadID}`
    if (row === undefined) return null

    return row.entries as readonly unknown[]
  },

  write: async (threadID, entries) => {
    await sql`
      insert into sessions (thread_id, entries, updated_at)
      values (${threadID}, ${entries}, now())
      on conflict (thread_id) do update set entries = excluded.entries, updated_at = now()
    `
  },
})
