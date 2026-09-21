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
import { z } from 'zod'

/**
 * What an artifact looks like once it is written down, which is not what it looks like on
 * the wire.
 *
 * On the wire an artifact carries a link. A link to object storage is signed and expires in
 * an hour, so writing that link into the record turns a fact that stays true into one that
 * stops being true overnight -- a reload the next morning hands the browser a dead URL. The
 * record keeps the one thing that does stay true, the object's key, and whoever reads it
 * mints a fresh link then.
 *
 * It lives here rather than in `@vid/contract` on purpose: a key is an internal path, and
 * the contract is the package the browser imports.
 */
export const StoredArtifact = z.object({
  key: z.string().min(1),
  role: z.enum(['preview', 'final']),
})

export type StoredArtifact = z.infer<typeof StoredArtifact>

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
