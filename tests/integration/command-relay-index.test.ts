import { expect, test } from 'bun:test'
import { sql } from 'kysely'
import { openTestDatabase } from './database-fixture'

test('pending command polling reads bounded buffers despite retained published history', async () => {
  const { db, close } = openTestDatabase()
  try {
    await db
      .transaction()
      .execute(async (tx) => {
        const threadID = crypto.randomUUID()
        const ownerID = crypto.randomUUID()
        await tx
          .insertInto('auth.user')
          .values({
            id: ownerID,
            name: 'Relay index',
            email: `${ownerID}@fixture.invalid`,
            emailVerified: true,
          })
          .execute()
        await tx
          .insertInto('product.threads')
          .values({ thread_id: threadID, owner_id: ownerID })
          .execute()
        // Retained JSON is deliberately large enough to exercise heap reads, not
        // wall-clock timing. The transaction rolls back only this test's own rows.
        await sql`
        insert into product.command_outbox(command_id, thread_id, run_id, command, published_at)
        select gen_random_uuid(), ${threadID}::uuid, gen_random_uuid(),
          jsonb_build_object('evidence', repeat('x', 256)), clock_timestamp()
        from generate_series(1, 12000)
      `.execute(tx)
        const commandID = crypto.randomUUID()
        await tx
          .insertInto('product.command_outbox')
          .values({
            command_id: commandID,
            thread_id: threadID,
            run_id: crypto.randomUUID(),
            command: {},
          })
          .execute()
        await sql`analyze product.command_outbox`.execute(tx)
        const result = await sql<{
          'QUERY PLAN': {
            Plan: {
              'Shared Hit Blocks': number
              'Shared Read Blocks': number
              'Actual Rows': number
            }
          }[]
        }>`
        explain (analyze, buffers, format json)
        select command_id from product.command_outbox
        where published_at is null order by created_at, command_id limit 32
      `.execute(tx)
        const plan = result.rows[0]?.['QUERY PLAN'][0]?.Plan
        if (!plan) throw new Error('Missing actual PostgreSQL plan')
        expect(plan['Actual Rows']).toBe(1)
        expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(100)
        // Rollback is explicit; successful test execution must not retain evidence.
        throw rollback
      })
      .catch((cause: unknown) => {
        if (cause !== rollback) throw cause
      })
  } finally {
    await close()
  }
}, 15000)

const rollback = new Error('Owned relay plan rollback')
