import type { Change, Snapshot } from '../../domain/message'
import type { Thread } from '../../domain/thread'

export type Conversations = {
  open: (thread: { threadID: string; userID: string }) => Promise<void>
  thread: (threadID: string) => Promise<Thread | null>

  /** Commit the message and command together; identical command replay is accepted once. */
  accept: (input: {
    threadID: string
    commandID: string
    message: string
  }) => Promise<'accepted' | 'conflict'>

  stop: (request: { threadID: string; commandID: string; turnID: string }) => Promise<void>

  /** Read the projection and its cursor from one consistent snapshot. */
  snapshot: (threadID: string) => Promise<Snapshot>

  changes: (cursor: {
    threadID: string
    after: string
  }) => Promise<{ cursor: string; change: Change }[]>
}
