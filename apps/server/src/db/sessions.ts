import type { DB } from '@vid/database/types'
import type { Kysely } from 'kysely'

/** This identity is from fresh SDK verification, never a client body. A missing
 * row already means revoked; a failed DELETE must escape before cookie clearing.
 * Better Auth 1.7.7 catches deletion failures in signOut and still returns 200,
 * so the application commits this stronger authority before SDK serialization.
 */
export async function revokeSession(
  db: Kysely<DB>,
  identity: Readonly<{ sessionID: string; userID: string }>,
) {
  await db
    .deleteFrom('auth.session')
    .where('id', '=', identity.sessionID)
    .where('userId', '=', identity.userID)
    .execute()
}
