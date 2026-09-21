import { EventType, type Event, type Message as PublicMessage } from '@ag-ui/core'
import type { Message, Change, Snapshot } from '../../domain/message'

export type SignLink = (key: string) => Promise<string>

/**
 * AG-UI snapshots do not encode unfinished text. Replay each open message's start and
 * accumulated content after the snapshot so subsequent deltas have an open destination.
 */
export const snapshotEvents = async (
  snapshot: Snapshot,
  sign: SignLink,
  threadID: string,
): Promise<Event[]> => {
  const messages = await Promise.all(
    snapshot.messages.map((message) => snapshotMessages(message, sign)),
  )

  const events: Event[] = [
    {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: messages.flat(),
    },
  ]

  for (const message of snapshot.messages) {
    if (message.kind === 'text' && !message.finished) events.push(...textEvents(message))
  }

  // An idle snapshot also ends the browser's working state; it has no live run ID.
  if (snapshot.activeTurnID !== null)
    events.push({ type: EventType.RUN_STARTED, threadId: threadID, runId: snapshot.activeTurnID })
  else events.push({ type: EventType.RUN_FINISHED, threadId: threadID, runId: 'snapshot' })

  return events
}

/** Translate committed product changes into the browser protocol; internal details stay here. */
export const changeEvents = async (
  change: Change,
  sign: SignLink,
  threadID: string,
): Promise<Event[]> => {
  if (change.kind === 'started')
    return [{ type: EventType.RUN_STARTED, threadId: threadID, runId: change.turnID }]
  if (change.kind === 'finished') return terminalEvents(change, threadID)
  if (change.kind === 'text') return [textEvent(change)]
  if (change.message.kind === 'text') return textEvents(change.message)

  const message = await publicActivity(change.message, sign)
  return [
    {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: message.id,
      activityType: message.activityType,
      content: message.content,
    },
  ]
}

/**
 * Reasoning has a live channel but is not a transcript message. An empty assistant
 * message would invent a reply merely to fit AG-UI's snapshot vocabulary.
 */
const snapshotMessages = async (message: Message, sign: SignLink): Promise<PublicMessage[]> => {
  if (message.kind === 'activity') return [await publicActivity(message, sign)]
  if (message.author === 'reasoning') return []

  return [{ id: message.id, role: message.author, content: message.text }]
}

/** Sign stored artifact keys on each presentation, including replays and refreshed snapshots. */
const publicActivity = async (
  message: Extract<Message, { kind: 'activity' }>,
  sign: SignLink,
): Promise<Extract<PublicMessage, { role: 'activity' }>> => {
  const { kind, ...content } = message.activity

  if (message.activity.kind === 'artifact') {
    return {
      id: message.id,
      role: 'activity',
      activityType: kind,
      content: { url: await sign(message.activity.key), role: message.activity.role },
    }
  }

  return { id: message.id, role: 'activity', activityType: kind, content }
}

/** Execution diagnostics can contain provider details; only the outcome selects public wording. */
const terminalEvents = (
  change: Extract<Change, { kind: 'finished' }>,
  threadID: string,
): Event[] => {
  if (change.outcome === 'succeeded' || change.outcome === 'cancelled')
    return [{ type: EventType.RUN_FINISHED, threadId: threadID, runId: change.turnID }]

  const message =
    change.outcome === 'interrupted'
      ? 'Execution was interrupted. Send a message to continue from the last saved state.'
      : 'Execution failed. Send a message to try again.'

  return [{ type: EventType.RUN_ERROR, message }]
}

const textEvents = (message: Extract<Message, { kind: 'text' }>): Event[] => {
  const change = { kind: 'text' as const, messageID: message.id, author: message.author }
  const events = [textEvent({ ...change, phase: 'start', delta: '' })]

  if (message.text !== '')
    events.push(textEvent({ ...change, phase: 'delta', delta: message.text }))

  if (message.finished) events.push(textEvent({ ...change, phase: 'end', delta: '' }))

  return events
}

/** Reasoning and transcript text have separate AG-UI channels, even with the same lifecycle. */
const textEvent = (change: Extract<Change, { kind: 'text' }>): Event => {
  const messageId = change.messageID

  if (change.author === 'reasoning') {
    if (change.phase === 'start')
      return { type: EventType.REASONING_MESSAGE_START, messageId, role: 'reasoning' }
    if (change.phase === 'delta')
      return { type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta: change.delta }
    return { type: EventType.REASONING_MESSAGE_END, messageId }
  }

  if (change.phase === 'start')
    return { type: EventType.TEXT_MESSAGE_START, messageId, role: change.author }
  if (change.phase === 'delta')
    return { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: change.delta }
  return { type: EventType.TEXT_MESSAGE_END, messageId }
}
