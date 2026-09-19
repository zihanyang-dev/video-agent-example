/**
 * The durable conversation, on Postgres.
 *
 * Six statements and no query builder. Nothing here is composed at runtime -- every query
 * is written out, which is what makes the tagged template safe and why the schema needs no
 * description in TypeScript to mirror it.
 *
 * Bodies go in and come out as objects: `jsonb` columns need no stringify and no parse.
 * Postgres does not preserve key order inside `jsonb`, which costs nothing here because
 * every reader addresses fields by name.
 */
import type { Message } from '@ag-ui/core'
import type { SQL } from 'bun'
import type { Messages, Thread } from './messages'

export const createPostgresMessages = (sql: SQL): Messages => ({
  thread: async (threadID) => {
    const [row] = await sql`
      select thread_id, user_id from threads where thread_id = ${threadID}
    `
    if (row === undefined) return null

    return { threadID: row.thread_id, userID: row.user_id } satisfies Thread
  },

  read: async (threadID) => {
    const rows = await sql`
      select body from messages where thread_id = ${threadID} order by seq
    `
    return rows.map((row: { body: Message }) => row.body)
  },

  append: async (threadID, message) => {
    await sql`
      insert into messages (thread_id, message_id, body)
      values (${threadID}, ${message.id}, ${message})
    `
  },

  /**
   * An upsert rather than an update, because the two calls race in exactly one case: a
   * script announces and settles an activity inside the same burst of output, and which
   * write lands first is not ours to decide. Either order leaves the settled body.
   */
  replace: async (threadID, message) => {
    await sql`
      insert into messages (thread_id, message_id, body)
      values (${threadID}, ${message.id}, ${message})
      on conflict (thread_id, message_id) do update set body = excluded.body
    `
  },
})
