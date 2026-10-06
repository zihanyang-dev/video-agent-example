import { sql } from 'kysely'

/** Use the fixed `start` outbox alias. Wire UUIDs may be historical uppercase,
 * but every indexed identity and the numeric protocol version must agree.
 * Consumers still own thread locks, user scope, joins and terminal selection. */
export function acceptedStartIdentity() {
  return sql<boolean>`
    start.command ->> 'kind' = 'start'
    and start.command -> 'version' = '1'::jsonb
    and lower(start.command ->> 'threadID') = start.thread_id::text
    and lower(start.command ->> 'runID') = start.run_id::text
    and lower(start.command ->> 'commandID') = start.command_id::text
    and lower(start.command #>> '{input,messageID}') = start.message_id::text
  `
}
