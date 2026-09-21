/**
 * The live stream: what a connected browser is reading right now.
 *
 * Separate from stored messages because the unit is different. Measured: a 131-character
 * reply arrives as 33 text deltas, roughly four characters each -- a two thousand character
 * reply is five hundred events. None of them is worth a row, and none of them should be
 * replayed to someone opening the page tomorrow (architecture.md §3).
 *
 * Out of process, and that is not a scaling choice. The SSE connection lives in `server`
 * while the turn runs in `agent`; an in-memory emitter would only ever reach half of them.
 *
 * Nothing here is truth. A browser may render from it, but it must not keep it: the same
 * fact in two places disagrees after some refresh, and then nobody knows which to believe.
 */
import type { Event } from '@ag-ui/core'

/**
 * Where a reader is resuming from.
 *
 * `after` is a position in the stream, not a thread. Both are opaque strings, so they are
 * named rather than positional -- swapping them would compile and would answer with an
 * empty stream, which reads exactly like a quiet conversation.
 */
export type StreamCursor = {
  thread: string
  /** Null starts from the beginning of what the stream still holds. */
  after: string | null
}

export type LiveStream = {
  publish: (threadID: string, event: Event) => Promise<void>
  /**
   * Whether a cursor can still be resumed from, or whether the stream has moved past it.
   *
   * Fragments are only kept for a window. A reader further behind than that cannot be
   * caught up by resuming -- everything it missed is gone -- so it has to be told, and sent
   * the whole conversation again instead. Without this the resume succeeds, quietly, and
   * delivers a page with a hole in the middle of it.
   */
  reachable: (cursor: StreamCursor) => Promise<boolean>
  /**
   * Yields events published after the cursor, then keeps yielding until `signal` aborts.
   *
   * Laptops close and trains go into tunnels. A stream without positions turns both of
   * those into a hole in the page.
   */
  read: (cursor: StreamCursor, signal: AbortSignal) => AsyncIterable<{ id: string; event: Event }>
}
