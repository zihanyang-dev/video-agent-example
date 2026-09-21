import type { SQL } from 'bun'
import type { Mailbox } from '@vid/queue'

/**
 * Keep the bounded batch locked through publication. A crash after Redis accepts a
 * message but before commit resends it; marking delivered first would instead lose it.
 * Receivers deduplicate by the ID stored in the outbox, never by the Redis stream ID.
 */
export const publishCommands = (sql: SQL, mailbox: Mailbox): Promise<void> =>
  sql.begin(async (tx) => {
    const commands = await tx`
      select seq, body
      from product.outbox
      where not delivered
      order by seq
      limit 50
      for update
    `

    for (const command of commands) {
      await mailbox.publish(command.body)
      await tx`
        update product.outbox
        set delivered = true
        where seq = ${command.seq}
      `
    }
  })
