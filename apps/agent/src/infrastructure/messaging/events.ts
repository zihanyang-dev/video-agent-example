import type { SQL } from 'bun'
import type { Mailbox } from '@vid/queue'

// Keep the bounded batch locked through publication. A crash after Redis accepts a
// message but before commit resends it; marking delivered first would instead lose it.
// Receivers deduplicate by the ID stored in the outbox, never by the Redis stream ID.
export const publishEvents = (sql: SQL, mailbox: Mailbox): Promise<void> =>
  sql.begin(async (transaction) => {
    const events = await transaction`
      select seq, body
      from execution.outbox
      where not delivered
      order by seq
      limit 100
      for update
    `
    for (const event of events) {
      await mailbox.publish(event.body)
      await transaction`
        update execution.outbox
        set delivered = true
        where seq = ${event.seq}
      `
    }
  })
