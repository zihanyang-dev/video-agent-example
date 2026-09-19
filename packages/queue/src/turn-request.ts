/**
 * The seam between `server` and `agent`.
 *
 * Not an optimisation. A turn runs for minutes; an HTTP process restarts whenever the front
 * end ships. A queue is what lets those two lifetimes be independent -- server restarting
 * does not disturb a turn in flight, and a turn does not hold an HTTP connection open
 * (architecture.md §2).
 *
 * Deliberately not in `@vid/contract`: the web app has no business knowing what a queue
 * payload looks like, and `contract` is the package it imports.
 */
import { z } from 'zod'

/**
 * Carries only what identifies the work.
 *
 * The conversation is read from storage by the agent, not carried here. Putting it in the
 * payload would make one queue entry grow with the conversation, and a redelivery would
 * replay a copy that was already stale when it was written.
 */
export const TurnRequest = z.object({
  threadID: z.string().min(1),
  userID: z.string().min(1),
  /** Correlates this turn across the queue, the event stream and the stored messages. */
  turnID: z.string().min(1),
  message: z.string(),
})

export type TurnRequest = z.infer<typeof TurnRequest>

export type TurnQueue = {
  put: (turn: TurnRequest) => Promise<void>
  /**
   * Runs `handle` for each turn until `close` resolves. A turn that throws is the queue
   * implementation's business, not this type's -- redelivery is one of the few places where
   * doing the work twice is cheaper than losing it.
   */
  take: (handle: (turn: TurnRequest) => Promise<void>) => Promise<void>
  /** Stops accepting new turns and waits for the ones in flight (architecture.md §2). */
  close: () => Promise<void>
}
