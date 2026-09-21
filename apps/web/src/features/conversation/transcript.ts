/**
 * The browser's display state is derived from public events, never from execution records.
 *
 * Snapshots replace local rows, streamed text extends only open messages, and activities
 * replace by message ID while keeping their position. These rules let optimistic messages
 * and reconnect replays converge on the server's public transcript.
 */
import { EventType, type Event, type Message } from '@ag-ui/core'
import {
  Activity,
  ARTIFACT,
  ASK,
  PLAN,
  STEP,
  type ArtifactContent,
  type AskContent,
  type PlanContent,
  type StepContent,
} from '@vid/contract/public'

export type TranscriptEntry =
  | { kind: 'said'; id: string; from: 'person' | 'agent'; text: string; finished: boolean }
  | { kind: 'thought'; id: string; text: string; finished: boolean }
  | ({ kind: 'plan'; id: string } & PlanContent)
  | ({ kind: 'step'; id: string } & StepContent)
  | ({ kind: 'artifact'; id: string } & ArtifactContent)
  | ({ kind: 'ask'; id: string } & AskContent)

export type Delivered = Extract<TranscriptEntry, { kind: 'artifact' }>

export type Transcript = {
  items: readonly TranscriptEntry[]
  working: boolean
  broke: string | null
}

export const nothingYet: Transcript = { items: [], working: false, broke: null }

// AG-UI also describes tools and other channels this product does not expose. Unused
// protocol events are ignored; our own activity union below remains exhaustive.
export const advance = (transcript: Transcript, event: Event): Transcript => {
  switch (event.type) {
    // Replace, rather than merge, so stale local fragments cannot survive an authoritative reload.
    case EventType.MESSAGES_SNAPSHOT:
      return { ...transcript, items: event.messages.flatMap(restoreMessage) }

    case EventType.RUN_STARTED:
      return { ...transcript, working: true, broke: null }

    case EventType.RUN_FINISHED:
      return { ...transcript, items: withoutThoughts(transcript.items), working: false }

    case EventType.RUN_ERROR:
      return {
        ...transcript,
        items: withoutThoughts(transcript.items),
        working: false,
        broke: event.message,
      }

    default:
      return applyMessageEvent(transcript, event)
  }
}

export const asked = (transcript: Transcript, id: string, text: string): Transcript =>
  append(transcript, { kind: 'said', id, from: 'person', text, finished: true })

export const deliveries = (transcript: Transcript): readonly Delivered[] =>
  transcript.items.filter((item): item is Delivered => item.kind === 'artifact')

export const latestFinal = (transcript: Transcript): Delivered | null => {
  const finals = transcript.items.filter(
    (item): item is Delivered => item.kind === 'artifact' && item.role === 'final',
  )
  return finals.at(-1) ?? null
}

const applyMessageEvent = (transcript: Transcript, event: Event): Transcript => {
  switch (event.type) {
    case EventType.TEXT_MESSAGE_START:
      return upsert(transcript, {
        kind: 'said',
        id: event.messageId,
        from: event.role === 'user' ? 'person' : 'agent',
        text: '',
        finished: false,
      })

    case EventType.TEXT_MESSAGE_CONTENT:
      return appendTextDelta(transcript, event.messageId, event.delta)

    case EventType.TEXT_MESSAGE_END:
      return finishText(transcript, event.messageId)

    case EventType.REASONING_MESSAGE_START:
      return upsert(transcript, { kind: 'thought', id: event.messageId, text: '', finished: false })

    case EventType.REASONING_MESSAGE_CONTENT:
      return appendTextDelta(transcript, event.messageId, event.delta)

    case EventType.REASONING_MESSAGE_END:
      return finishText(transcript, event.messageId)

    case EventType.ACTIVITY_SNAPSHOT:
      return upsert(transcript, parseActivity(event.messageId, event.activityType, event.content))

    default:
      return transcript
  }
}

const restoreMessage = (message: Message): TranscriptEntry[] => {
  if (message.role === 'user' || message.role === 'assistant') {
    return [
      {
        kind: 'said',
        id: message.id,
        from: message.role === 'user' ? 'person' : 'agent',
        text: typeof message.content === 'string' ? message.content : '',
        finished: true,
      },
    ]
  }

  if (message.role === 'activity') {
    const item = parseActivity(message.id, message.activityType, message.content)
    return item === null ? [] : [item]
  }

  return []
}

// AG-UI leaves activity content open; parse our product vocabulary at that extension point.
const parseActivity = (
  id: string,
  activityType: string,
  content: unknown,
): TranscriptEntry | null => {
  const activity = Activity.safeParse({ activityType, content })
  if (!activity.success) return null

  switch (activity.data.activityType) {
    case PLAN:
      return { kind: 'plan', id, ...activity.data.content }
    case STEP:
      return { kind: 'step', id, ...activity.data.content }
    case ARTIFACT:
      return { kind: 'artifact', id, ...activity.data.content }
    case ASK:
      return { kind: 'ask', id, ...activity.data.content }
    default:
      return assertNever(activity.data)
  }
}

const assertNever = (activity: never): never => {
  throw new Error(`unhandled activity: ${JSON.stringify(activity)}`)
}

const withoutThoughts = (items: readonly TranscriptEntry[]): readonly TranscriptEntry[] =>
  items.filter((item) => item.kind !== 'thought')

const append = (transcript: Transcript, item: TranscriptEntry): Transcript => ({
  ...transcript,
  items: [...transcript.items, item],
})

// Replayed starts and optimistic echoes replace by ID. Activity updates use the same
// rule but keep their original position, so a finishing step does not jump past replies.
const upsert = (transcript: Transcript, item: TranscriptEntry | null): Transcript => {
  if (item === null) return transcript

  const index = transcript.items.findIndex((existing) => existing.id === item.id)
  if (index === -1) return append(transcript, item)

  const items = [...transcript.items]
  items[index] = item

  return { ...transcript, items }
}

// Only an open message accepts deltas; a repeated tail must not extend a completed reply.
const appendTextDelta = (transcript: Transcript, id: string, delta: string): Transcript =>
  updateEntry(transcript, id, (item) => {
    if (item.kind !== 'said' && item.kind !== 'thought') return item
    if (item.finished) return item

    return { ...item, text: item.text + delta }
  })

const finishText = (transcript: Transcript, id: string): Transcript =>
  updateEntry(transcript, id, (item) =>
    item.kind === 'said' || item.kind === 'thought' ? { ...item, finished: true } : item,
  )

const updateEntry = (
  transcript: Transcript,
  id: string,
  change: (item: TranscriptEntry) => TranscriptEntry,
): Transcript => {
  const index = transcript.items.findIndex((item) => item.id === id)
  if (index === -1) return transcript

  const items = [...transcript.items]
  items[index] = change(items[index]!)

  return { ...transcript, items }
}
