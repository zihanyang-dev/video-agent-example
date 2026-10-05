import { EventSchema } from '@ag-ui/core/schemas'
import { EventType, type BaseEvent } from '@ag-ui/core'
import type { PublicMessage } from '@vid/contract/http'

export type TranscriptMessage = Pick<
  PublicMessage,
  'messageID' | 'role' | 'text' | 'assets'
>
export type RunView = Readonly<{
  messages: readonly TranscriptMessage[]
  seen: ReadonlySet<string>
  after: string
  terminal: boolean
  error: string
}>

export function emptyRunView(): RunView {
  return {
    messages: [],
    seen: new Set(),
    after: '0',
    terminal: false,
    error: '',
  }
}

// This view owns only transient public text. Query holds persisted messages and
// active runs; neither an SDK error nor a disconnect can decide execution state.
export function reduceRunEvent(view: RunView, frame: BaseEvent): RunView {
  const event = EventSchema.parse(frame)
  const eventID = event.metadata?.eventID
  if (typeof eventID !== 'string' || view.seen.has(eventID)) return view
  const seen = new Set(view.seen)
  seen.add(eventID)
  const cursor = event.metadata?.cursor
  const next = {
    ...view,
    seen,
    after: typeof cursor === 'string' ? cursor : view.after,
  }
  if (
    event.type === EventType.RUN_FINISHED ||
    event.type === EventType.RUN_ERROR
  )
    return {
      ...next,
      terminal: true,
      error: event.type === EventType.RUN_ERROR ? event.message : '',
    }
  if (event.type !== EventType.TEXT_MESSAGE_CONTENT) return next
  return appendDelta(next, {
    messageID: event.messageId.toLowerCase(),
    delta: event.delta,
  })
}

function appendDelta(
  view: RunView,
  content: Readonly<{ messageID: string; delta: string }>,
): RunView {
  const previous = view.messages.find(
    (message) => message.messageID === content.messageID,
  )
  const message: TranscriptMessage = {
    messageID: content.messageID,
    role: 'assistant',
    text: (previous?.text ?? '') + content.delta,
  }
  return {
    ...view,
    messages: [
      ...view.messages.filter((entry) => entry.messageID !== message.messageID),
      message,
    ],
  }
}

export function pendingTranscript(
  snapshot: readonly PublicMessage[],
  view: RunView,
): readonly TranscriptMessage[] {
  const persistedIDs = new Set(snapshot.map((message) => message.messageID))
  // A final product snapshot wins even when completion corrects non-prefix draft
  // text. Never put streamed approximations into the persisted fact cache.
  return view.messages.filter((message) => !persistedIDs.has(message.messageID))
}
