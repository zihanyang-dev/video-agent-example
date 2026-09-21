/**
 * Which threads have a turn running, and what a second message for one of them does.
 *
 * An owner: one rule, no I/O, no knowledge of queues or sandboxes. The rule is
 *
 *     **one turn per thread, ever.**
 *
 * It is not a throughput decision, it is an ownership one. A turn carries the thread's whole
 * workspace into a sandbox at the start and back out at the end, and keeps the thread's
 * session. Two turns on one thread would carry the same files in twice, write over each
 * other's results, and settle in whichever order they happened to finish. Running them on
 * *different* threads is free, because they share nothing.
 *
 * So a message that arrives for a thread already working does not wait for a turn of its
 * own -- it joins the one that is running. That is what a person means when they type
 * something while watching it work, and it is the only thing `steer` was ever for.
 *
 * ## The race this is shaped around
 *
 * A turn can finish between "is this thread busy?" and "then steer it". `offer` is therefore
 * synchronous up to the point of decision: it reads the flag and puts the message on the
 * turn's own list without awaiting anything in between, so nothing can end underneath it.
 * A turn that has stopped accepting says so, and the caller runs a real turn instead.
 */

export type Steerable = {
  /** Handed each message that arrived while this turn was running, in order. */
  steer: (message: string) => Promise<void>
}

export type InFlight = {
  /**
   * Registers a turn as the owner of its thread, and returns how to give it up.
   *
   * Throws if the thread already has one: that is a bug in the caller, and a quiet second
   * registration would mean two turns writing to one workspace.
   */
  claim: (threadID: string, turn: Steerable) => () => void
  /**
   * Hands a message to the turn running on this thread.
   *
   * True when it was taken, false when there is no turn or it has stopped accepting -- and
   * false means the caller should run it as a turn of its own.
   */
  offer: (threadID: string, message: string) => boolean
  /** Which threads are working. What a drain waits on. */
  busy: () => readonly string[]
}

type Entry = {
  turn: Steerable
  accepting: boolean
  /**
   * Steers are applied one after another.
   *
   * Two messages typed a second apart must reach the harness in the order they were typed,
   * and `steer` is async, so a chain is what keeps them from overtaking each other.
   */
  pending: Promise<unknown>
}

export const createInFlight = (): InFlight => {
  const entries = new Map<string, Entry>()

  const claim = (threadID: string, turn: Steerable): (() => void) => {
    if (entries.has(threadID)) {
      throw new Error(`thread ${threadID} already has a turn running`)
    }

    const entry: Entry = { turn, accepting: true, pending: Promise.resolve() }
    entries.set(threadID, entry)

    return () => {
      // Stops accepting before it stops existing, so a steer decided a moment ago is
      // refused rather than handed to a harness that is already gone.
      entry.accepting = false
      entries.delete(threadID)
    }
  }

  const offer = (threadID: string, message: string): boolean => {
    const entry = entries.get(threadID)
    if (entry === undefined || !entry.accepting) return false

    // Nothing is awaited between the check above and this line, which is what makes the
    // decision safe: the turn cannot end in the middle of it.
    entry.pending = entry.pending.then(() => entry.turn.steer(message))
    return true
  }

  return { claim, offer, busy: () => [...entries.keys()] }
}
