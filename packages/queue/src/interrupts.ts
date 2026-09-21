/**
 * Telling a running turn to stop.
 *
 * A broadcast, not a queue, and the difference is the whole reason this is a separate
 * module. The turn queue is a consumer group: an entry goes to exactly one agent, chosen by
 * Redis, which is right for work and wrong for control. An interrupt has to reach the one
 * process that happens to be holding that thread -- give it to any other and it lands
 * nowhere while the turn it was meant for keeps running.
 *
 * So every agent hears every interrupt and ignores the threads it does not own. That costs
 * a message to processes with nothing to do about it, which is nothing: a person can only
 * press stop so often.
 *
 * Nothing is persisted. An interrupt for a turn that already ended is not worth keeping --
 * it would be delivered to whatever ran next, which is the opposite of what was asked for.
 */
import { RedisClient } from 'bun'

const CHANNEL = 'interrupts'

export type Interrupts = {
  /** Asks whoever is running this thread to stop. Returns once the ask is out. */
  request: (threadID: string) => Promise<void>
  /**
   * Hears every request, including ones for threads this process knows nothing about.
   *
   * The handler decides: `in-flight.ts` owns which threads are ours.
   */
  listen: (stop: (threadID: string) => void) => Promise<void>
  close: () => void
}

export const createRedisInterrupts = (url: string): Interrupts => {
  // Two connections on purpose: a subscribed Redis client may not issue ordinary commands,
  // so a process that both asks and listens needs one of each.
  const talking = new RedisClient(url)
  const listening = new RedisClient(url)

  return {
    request: async (threadID) => {
      await talking.publish(CHANNEL, threadID)
    },

    listen: async (stop) => {
      await listening.subscribe(CHANNEL, (message: string) => stop(message))
    },

    close: () => {
      talking.close()
      listening.close()
    },
  }
}
