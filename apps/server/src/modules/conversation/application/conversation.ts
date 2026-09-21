import type { Conversations } from './ports/conversations'
import { mayRead, type Reader } from '../domain/thread'

/**
 * Apply conversation ownership before reading or issuing commands.
 * Persistence owns the atomic message/outbox commit and command replay rules.
 */
export const createConversation = (store: Conversations) => ({
  open: async (reader: Reader) => {
    const threadID = crypto.randomUUID()
    await store.open({ threadID, userID: reader.userID })

    return threadID
  },

  access: async (reader: Reader, threadID: string) => {
    const thread = await store.thread(threadID)
    return mayRead(thread, reader) ? thread : null
  },

  accept: async (
    reader: Reader,
    input: { threadID: string; commandID: string; message: string },
  ) => {
    if (!mayRead(await store.thread(input.threadID), reader)) return 'inaccessible' as const

    return store.accept(input)
  },

  stop: async (reader: Reader, threadID: string) => {
    const thread = await store.thread(threadID)
    if (!mayRead(thread, reader)) return false
    if (thread.activeTurnID === null) return true

    // Capture the visible turn now; a delayed stop must not cancel a later turn.
    await store.stop({ threadID, commandID: crypto.randomUUID(), turnID: thread.activeTurnID })

    return true
  },
})

export type Conversation = ReturnType<typeof createConversation>
