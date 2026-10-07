import { readAdministrationEnv } from '@vid/config'
import { openDatabase } from '@vid/database/connection'
import type { DB } from '@vid/database/types'
import { sql, type Kysely } from 'kysely'

/** Read-only evidence for manual investigation, never permission to requeue.
 * Receiver absence does not prove work never ran or SQL history is intact.
 */
export async function inspectDelivery(db: Kysely<DB>, kind: 'command' | 'event', id: string) {
  return await db.transaction().execute(async (tx) => {
    await sql`set transaction isolation level repeatable read, read only`.execute(tx)
    if (kind === 'command') {
      return {
        sender: await tx
          .selectFrom('product.command_outbox')
          .selectAll()
          .where('command_id', '=', id)
          .executeTakeFirst(),
        receiver: await tx
          .selectFrom('execution.command_inbox')
          .selectAll()
          .where('command_id', '=', id)
          .executeTakeFirst(),
      }
    }
    return {
      sender: await tx
        .selectFrom('execution.event_outbox')
        .selectAll()
        .where('event_id', '=', id)
        .executeTakeFirst(),
      receiver: await tx
        .selectFrom('product.execution_events')
        .selectAll()
        .where('event_id', '=', id)
        .executeTakeFirst(),
    }
  })
}

async function runInspection(kind: 'command' | 'event', id: string) {
  let db: Kysely<DB> | undefined
  try {
    db = openDatabase(readAdministrationEnv(), () => {
      process.exitCode = 1
    })
    console.log(JSON.stringify(await inspectDelivery(db, kind, id), null, 2))
  } catch {
    // Native error rendering can disclose SQL payloads or credentials.
    console.error(
      'Inspection failed; verify the original database and identities. Do not retry execution.',
    )
    process.exitCode = 1
  } finally {
    try {
      await db?.destroy()
    } catch {
      console.error('Database cleanup failed')
      process.exitCode = 1
    }
  }
}

if (import.meta.main) {
  const [kind, id, ...extra] = process.argv.slice(2)
  if (
    (kind !== 'command' && kind !== 'event') ||
    !id ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ||
    extra.length
  ) {
    console.error(
      'Usage: bun scripts/reconcile-deliveries.ts command|event original-uuid (read only)',
    )
    process.exitCode = 1
  } else {
    await runInspection(kind, id)
  }
}
