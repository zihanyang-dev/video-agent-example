/**
 * What is on the screen, as a function of what has arrived.
 *
 * An owner: pure, no React, no network. Everything hard about a streamed conversation lives
 * here -- a reply arriving in fragments, a step that starts before it finishes, a reconnect
 * replacing the lot -- and none of it needs a browser to test.
 *
 * It knows the AG-UI event vocabulary and our own activity vocabulary (`@vid/contract`) and
 * nothing else. There is deliberately no case for TOOL_CALL_*: the agent's tools are not
 * something a person is shown, and a reducer that quietly handled them would be the place
 * that decision got lost (architecture.md §6).
 */
import { EventType, type Event, type Message } from '@ag-ui/core'
import {
  Activity,
  ARTIFACT,
  ASK,
  STEP,
  type ArtifactContent,
  type AskContent,
  type StepContent,
} from '@vid/contract'

/**
 * One thing on the screen.
 *
 * The three activity kinds take their fields from `@vid/contract` rather than restating
 * them. Two descriptions of the same thing drift, and the drift shows up as a field
 * silently missing from a screen.
 */
export type Item =
  | { kind: 'said'; id: string; from: 'person' | 'agent'; text: string; finished: boolean }
  | { kind: 'thought'; id: string; text: string; finished: boolean }
  | ({ kind: 'step'; id: string } & StepContent)
  | ({ kind: 'artifact'; id: string } & ArtifactContent)
  | ({ kind: 'ask'; id: string } & AskContent)

/** Something the agent made, as a link a person can open. */
export type Delivered = Extract<Item, { kind: 'artifact' }>

export type Transcript = {
  items: readonly Item[]
  /** True between RUN_STARTED and whichever of RUN_FINISHED or RUN_ERROR comes first. */
  working: boolean
  /** Set only by RUN_ERROR, and cleared when the next turn starts. */
  broke: string | null
}

export const nothingYet: Transcript = { items: [], working: false, broke: null }

export const advance = (transcript: Transcript, event: Event): Transcript => {
  switch (event.type) {
    // A reconnect, or a page load. Everything before this is replaced rather than merged:
    // the snapshot is the truth, and merging would keep half-written fragments of a reply
    // that has since finished.
    case EventType.MESSAGES_SNAPSHOT:
      return { ...transcript, items: event.messages.flatMap(asItem) }

    case EventType.RUN_STARTED:
      return { ...transcript, working: true, broke: null }

    // Thinking is dropped when the turn it belonged to ends. It is the one thing on this
    // screen that is not part of the record -- it is never stored, so a reload could not
    // put it back in the right place even if it wanted to, and a pile of collapsed stubs
    // at the bottom of an old conversation is worse than not showing it (measured on the
    // first page load against a finished thread).
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
      return heard(transcript, event)
  }
}

/** The half of `advance` about what was said. Split off to keep either half readable. */
const heard = (transcript: Transcript, event: Event): Transcript => {
  switch (event.type) {
    case EventType.TEXT_MESSAGE_START:
      return begin(transcript, {
        kind: 'said',
        id: event.messageId,
        from: 'agent',
        text: '',
        finished: false,
      })

    case EventType.TEXT_MESSAGE_CONTENT:
      return grow(transcript, event.messageId, event.delta)

    case EventType.TEXT_MESSAGE_END:
      return finish(transcript, event.messageId)

    case EventType.REASONING_MESSAGE_START:
      return begin(transcript, { kind: 'thought', id: event.messageId, text: '', finished: false })

    case EventType.REASONING_MESSAGE_CONTENT:
      return grow(transcript, event.messageId, event.delta)

    case EventType.REASONING_MESSAGE_END:
      return finish(transcript, event.messageId)

    // One activity is one thing on the screen however many times it is sent: a step that
    // starts and then finishes is one row that changes, not two rows.
    case EventType.ACTIVITY_SNAPSHOT:
      return upsert(transcript, fromActivity(event.messageId, event.activityType, event.content))

    default:
      return transcript
  }
}

/** Null for anything stored that has no place on a screen. */
const asItem = (message: Message): Item[] => {
  if (message.role === 'user') {
    return [
      {
        kind: 'said',
        id: message.id,
        from: 'person',
        text: typeof message.content === 'string' ? message.content : '',
        finished: true,
      },
    ]
  }

  if (message.role === 'assistant') {
    return [
      {
        kind: 'said',
        id: message.id,
        from: 'agent',
        text: typeof message.content === 'string' ? message.content : '',
        finished: true,
      },
    ]
  }

  if (message.role === 'activity') {
    const item = fromActivity(message.id, message.activityType, message.content)
    return item === null ? [] : [item]
  }

  // Reasoning is not stored, and a role we do not know is not something to guess at.
  return []
}

/**
 * Null for an activity this build cannot show, which includes one that does not match its
 * own contract.
 *
 * Parsed rather than coerced. The first version read the fields out and called `String()` on
 * them, which turns an activity whose `label` arrived as an object into the literal text
 * `[object Object]` on someone's screen -- a shape that is wrong is better dropped than
 * rendered, and the contract already describes every shape this may be.
 */
const fromActivity = (id: string, activityType: string, content: unknown): Item | null => {
  const activity = Activity.safeParse({ activityType, content })
  if (!activity.success) return null

  switch (activity.data.activityType) {
    case STEP:
      return { kind: 'step', id, ...activity.data.content }
    case ARTIFACT:
      return { kind: 'artifact', id, ...activity.data.content }
    case ASK:
      return { kind: 'ask', id, ...activity.data.content }
  }
}

const withoutThoughts = (items: readonly Item[]): readonly Item[] =>
  items.filter((item) => item.kind !== 'thought')

const append = (transcript: Transcript, item: Item): Transcript => ({
  ...transcript,
  items: [...transcript.items, item],
})

/**
 * Starts a message, or starts it over if it is already on screen.
 *
 * Starting over is what makes a reconnect idempotent. The stream still holds the whole
 * conversation, so a browser that arrives is sent the snapshot and then replayed the events
 * that built it. Appending on every start showed the finished conversation twice, with the
 * second copy missing its text -- the deltas all landed on the first copy (measured, on the
 * first page load against a real thread).
 *
 * Resetting instead means the replay rebuilds exactly what the snapshot already said, and a
 * reply that is still arriving keeps building from wherever the replay began.
 */
const begin = (transcript: Transcript, item: Item): Transcript => {
  const at = transcript.items.findIndex((existing) => existing.id === item.id)
  if (at === -1) return append(transcript, item)

  const items = [...transcript.items]
  items[at] = item
  return { ...transcript, items }
}

/**
 * Replaces in place when the id is already on screen, appends otherwise.
 *
 * In place matters: a step that settles must stay where it was. Removing and re-appending
 * would make a finished step jump past everything said while it ran.
 */
const upsert = (transcript: Transcript, item: Item | null): Transcript => {
  if (item === null) return transcript

  const at = transcript.items.findIndex((existing) => existing.id === item.id)
  if (at === -1) return append(transcript, item)

  const items = [...transcript.items]
  items[at] = item
  return { ...transcript, items }
}

/**
 * Appends to a message that is still being written, and ignores anything else.
 *
 * Ignoring a delta for a finished message is what makes a partial replay safe. A reconnect
 * whose cursor landed mid-reply is sent the snapshot -- where that reply is already whole --
 * and then replayed the tail of it with no `START` in front. Measured: the tail was appended
 * to the finished text, and the reply ended "...across the water.across the water."
 *
 * A replay that does include the `START` is unaffected: starting a message re-opens it, and
 * the deltas behind it rebuild exactly what the snapshot already said.
 */
const grow = (transcript: Transcript, id: string, delta: string): Transcript =>
  edit(transcript, id, (item) => {
    if (item.kind !== 'said' && item.kind !== 'thought') return item
    if (item.finished) return item

    return { ...item, text: item.text + delta }
  })

const finish = (transcript: Transcript, id: string): Transcript =>
  edit(transcript, id, (item) =>
    item.kind === 'said' || item.kind === 'thought' ? { ...item, finished: true } : item,
  )

/**
 * A delta for a message that never started is dropped rather than invented.
 *
 * It happens on a reconnect whose cursor lands mid-reply: the snapshot has the finished
 * message and the stream replays the tail of it. Inventing a second message from the tail
 * would show the end of the reply twice.
 */
const edit = (transcript: Transcript, id: string, change: (item: Item) => Item): Transcript => {
  const at = transcript.items.findIndex((item) => item.id === id)
  if (at === -1) return transcript

  const items = [...transcript.items]
  items[at] = change(items[at]!)
  return { ...transcript, items }
}

/**
 * What a person just typed, on screen before the server has echoed anything back.
 *
 * The round trip is short but the turn behind it is minutes long, and a message that takes
 * a moment to appear reads as one that was not sent -- so it is shown now and replaced by
 * the stored one whenever a snapshot next arrives.
 */
export const asked = (transcript: Transcript, id: string, text: string): Transcript =>
  append(transcript, { kind: 'said', id, from: 'person', text, finished: true })

/** What the stage shows: the most recent thing the agent said was finished. */
export const latestFinal = (transcript: Transcript): Delivered | null => {
  const finals = transcript.items.filter(
    (item): item is Delivered => item.kind === 'artifact' && item.role === 'final',
  )
  return finals.at(-1) ?? null
}
