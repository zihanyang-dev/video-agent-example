/**
 * Who a conversation belongs to.
 *
 * A pure rule over a record someone else fetched. It takes no database handle on purpose:
 * the moment an owner holds one, every test of it needs a database, and this rule is worth
 * testing without one (architecture.md §3).
 *
 * There is exactly one access rule today, which is why there is no access module. A second
 * one -- sharing a thread, a team workspace -- is when it becomes something with an
 * identity of its own.
 */
import type { Thread } from '@vid/store'

export type Reader = { userID: string }

export const mayRead = (thread: Thread | null, reader: Reader): thread is Thread =>
  thread !== null && thread.userID === reader.userID

/**
 * One answer for "not yours" and "not there", deliberately.
 *
 * Telling them apart would let anyone learn which thread ids exist by asking, and a person
 * who cannot read a thread has the same thing to do either way.
 */
export const NOT_READABLE = 'no such conversation'
