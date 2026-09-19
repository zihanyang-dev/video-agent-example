/**
 * The durable conversation: what a page load reads back.
 *
 * Stored as AG-UI `Message[]` rather than a shape of our own. `ActivityMessage` is already
 * in that union -- progress that is not conversation content, kept in sequence -- so a
 * reload is one MESSAGES_SNAPSHOT of what is here, with no translation step to get wrong
 * (architecture.md §3).
 *
 * Only completed things land here. Deltas belong to the live stream.
 *
 * This is not the agent's context. The harness keeps its own session entries -- tool calls,
 * tool results, compaction entries -- which no person ever reads. Two records of the same
 * conversation, answering two different questions (see `sessions.ts`).
 */
import type { Message } from '@ag-ui/core'

export type Thread = {
  threadID: string
  userID: string
}

export type Messages = {
  /** Null when the thread does not exist. Whether the caller may read it is not decided here. */
  thread: (threadID: string) => Promise<Thread | null>
  /**
   * Starts an empty conversation. Separate from the first message on purpose: a turn runs
   * for minutes and the page that will watch it has to exist first, so a person opens a
   * conversation and then says something into it.
   */
  open: (thread: Thread) => Promise<void>
  read: (threadID: string) => Promise<readonly Message[]>
  append: (threadID: string, message: Message) => Promise<void>
  /**
   * Replaces a message already stored, by its id. An activity settles by being written
   * again: ACTIVITY_SNAPSHOT replaces by default, so `running` and `done` are one message
   * rather than two, and nothing downstream has to remember which spinners are still
   * turning.
   */
  replace: (threadID: string, message: Message) => Promise<void>
}
