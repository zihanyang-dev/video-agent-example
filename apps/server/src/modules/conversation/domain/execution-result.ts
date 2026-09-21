import type { Activity, Message } from './message'

/** Execution progress after the transport envelope has been decoded. */
export type ExecutionUpdate =
  | { kind: 'started' }
  | {
      kind: 'finished'
      outcome: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
      reason: string | null
    }
  | { kind: 'text-start' | 'text-end'; messageID: string; channel: 'assistant' | 'reasoning' }
  | { kind: 'text-delta'; messageID: string; channel: 'assistant' | 'reasoning'; delta: string }
  | { kind: 'activity'; messageID: string; activity: Activity }

export type ExecutionResult = {
  eventID: string
  threadID: string
  turnID: string
  sequence: number
  update: ExecutionUpdate
}

/** Build the durable public message without exposing the execution transport's vocabulary. */
export const updateMessage = (
  previous: Message | null,
  update: Exclude<ExecutionUpdate, { kind: 'started' | 'finished' }>,
): Message => {
  if (update.kind === 'activity')
    return { id: update.messageID, kind: 'activity', activity: update.activity }

  const text = previous?.kind === 'text' ? previous.text : ''
  return {
    id: update.messageID,
    kind: 'text',
    author: update.channel,
    text: update.kind === 'text-delta' ? text + update.delta : text,
    finished: update.kind === 'text-end',
  }
}

/** Terminal runs cannot leave text open or an activity appearing to run forever. */
export const settleMessage = (message: Message): Message => {
  if (message.kind === 'text') return { ...message, finished: true }

  if (message.activity.kind === 'step' && message.activity.state === 'running') {
    return { ...message, activity: { ...message.activity, state: 'failed' } }
  }

  return message
}
