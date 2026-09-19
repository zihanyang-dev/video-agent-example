/**
 * What a page load gets.
 *
 * One AG-UI `MESSAGES_SNAPSHOT` of everything stored, which is the whole of it: the durable
 * record is already in the protocol's own shape, so there is no translation step here to
 * get wrong (architecture.md §3).
 *
 * Deltas are not here and never were. Five hundred fragments of a reply that finished
 * yesterday are not something to replay -- what was stored is what completed.
 */
import { EventType, type Event, type Message } from '@ag-ui/core'

export const snapshotOf = (messages: readonly Message[]): Event => ({
  type: EventType.MESSAGES_SNAPSHOT,
  messages: [...messages],
})
