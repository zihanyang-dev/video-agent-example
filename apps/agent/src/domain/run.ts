import type { Outcome } from './progress'

export type MessageInput = {
  commandID: string
  threadID: string
  message: string
}

export type StopInput = {
  commandID: string
  threadID: string
  turnID: string
}

export type Run = {
  turnID: string
  threadID: string
  message: string
  owner: string
}

// History and workspace must describe the same saved attempt; entries belong to the harness.
export type Checkpoint = {
  entries: readonly unknown[]
  workspace: string | null
}

export type Controls = {
  messages: MessageInput[]
  cancelled: boolean
}

// An abort caused by Stop is cancellation. Failure to save its checkpoint still needs
// separate recovery, so cancellation cannot hide a persistence failure.
export const completionOutcome = (state: {
  cancelled: boolean
  executionFailed: boolean
  persistenceFailed: boolean
}): Outcome => {
  if (state.persistenceFailed) return 'failed'
  if (state.cancelled) return 'cancelled'
  return state.executionFailed ? 'failed' : 'succeeded'
}
