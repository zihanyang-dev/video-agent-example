/**
 * The agent's own record of a conversation.
 *
 * Not the same thing as stored messages, and the difference matters. This holds the
 * harness's session entries -- tool calls, tool results, compaction entries -- which are
 * what the model is shown on the next turn and which no person ever reads. `messages.ts`
 * holds what a person reads and no model is shown (architecture.md §3).
 *
 * Opaque on purpose. The shape belongs to the harness; we store and return it. Measured: a
 * four-message conversation is six entries and 1658 bytes, and a fresh process rebuilt from
 * them remembers what was asked for.
 */
export type Sessions = {
  /** Null when this thread has never run a turn. */
  read: (threadID: string) => Promise<readonly unknown[] | null>
  write: (threadID: string, entries: readonly unknown[]) => Promise<void>
}
