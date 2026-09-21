/** Product activities retain object keys; presentation mints browser links on each read. */
export type Activity =
  | { kind: 'plan'; items: { label: string; state: 'todo' | 'doing' | 'done' | 'skipped' }[] }
  | {
      kind: 'step'
      label: string
      state: 'running' | 'done' | 'failed'
      detail?: string | undefined
    }
  | { kind: 'ask'; question: string; options: string[]; answer: string | null }
  | { kind: 'artifact'; key: string; role: 'preview' | 'final' }

/** The durable projection used by a fresh reader, including unfinished text. */
export type Message =
  | {
      id: string
      kind: 'text'
      author: 'user' | 'assistant' | 'reasoning'
      text: string
      finished: boolean
    }
  | { id: string; kind: 'activity'; activity: Activity }

/** Ordered projection changes replayed after a reader's last committed cursor. */
export type Change =
  | {
      kind: 'text'
      phase: 'start' | 'delta' | 'end'
      messageID: string
      author: 'user' | 'assistant' | 'reasoning'
      delta: string
    }
  | { kind: 'message'; message: Message }
  | { kind: 'started'; turnID: string }
  | {
      kind: 'finished'
      turnID: string
      outcome: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
      reason: string | null
    }

/** Messages, cursor and active turn must come from the same database snapshot. */
export type Snapshot = {
  messages: Message[]
  cursor: string
  activeTurnID: string | null
}
