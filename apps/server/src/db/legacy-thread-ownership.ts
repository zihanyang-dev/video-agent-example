import type { DB } from '@vid/database/types'
import { sql, type Kysely } from 'kysely'
import { z } from 'zod'

export const legacyAssignmentsSchema = z
  .array(
    z.strictObject({
      legacyOwnerID: z.string().min(1),
      userID: z.string().min(1),
    }),
  )
  .min(1)
  .refine(
    (assignments) =>
      new Set(assignments.map((assignment) => assignment.legacyOwnerID))
        .size === assignments.length,
    'Each legacy owner must occur once',
  )

/** Administrative, never called by login or product HTTP. The table lock keeps
 * the reviewed set fixed; user share locks prevent deletion before assignment.
 * Reject incomplete/unknown/conflicting mappings before any row is changed.
 * Original legacy owners remain audit evidence, not a second business entity. */
export async function assignLegacyThreads(
  db: Kysely<DB>,
  assignments: z.infer<typeof legacyAssignmentsSchema>,
) {
  return await db.transaction().execute(async (tx) => {
    await sql`lock table product.threads in share row exclusive mode`.execute(
      tx,
    )
    const threads = await tx
      .selectFrom('product.threads')
      .select(['thread_id', 'legacy_owner_id', 'owner_id'])
      .where('legacy_owner_id', 'is not', null)
      .execute()
    const reviewed = new Map(
      assignments.map((assignment) => [
        assignment.legacyOwnerID,
        assignment.userID,
      ]),
    )
    const users = await tx
      .selectFrom('auth.user')
      .select('id')
      .where('id', 'in', [...reviewed.values()])
      .forShare()
      .execute()
    if (
      new Set(users.map((user) => user.id)).size !==
      new Set(reviewed.values()).size
    )
      throw new Error('Assignment references an unknown authentication user')
    for (const thread of threads) {
      const ownerID = reviewed.get(thread.legacy_owner_id!)
      if (!ownerID)
        throw new Error('Assignment does not cover every legacy owner')
      if (thread.owner_id !== null && thread.owner_id !== ownerID)
        throw new Error('Assignment conflicts with a previously reviewed owner')
    }
    let assigned = 0
    for (const assignment of assignments) {
      const changed = await tx
        .updateTable('product.threads')
        .set({ owner_id: assignment.userID })
        .where('legacy_owner_id', '=', assignment.legacyOwnerID)
        .where('owner_id', 'is', null)
        .executeTakeFirst()
      assigned += Number(changed.numUpdatedRows)
    }
    return { assigned }
  })
}
