import { EventEncoder } from '@ag-ui/encoder'
import type { Event } from '@ag-ui/core'
import type { Conversations } from '../../application/ports/conversations'
import { snapshotEvents, changeEvents, type SignLink } from './history'

/** Own one reader's stream and cancellation without changing the durable conversation. */
export const streamConversation = (
  dependencies: { store: Conversations; sign: SignLink },
  threadID: string,
  resumeFrom: string | null,
  requestSignal: AbortSignal,
): Response => {
  // ReadableStream.cancel() closes its controller; an HTTP abort still needs us to close it.
  const readerCancellation = new AbortController()
  const signal = AbortSignal.any([readerCancellation.signal, requestSignal])

  const body = new ReadableStream<Uint8Array>({
    start: (controller) =>
      transmitEvents({
        ...dependencies,
        threadID,
        resumeFrom,
        signal,
        readerCancellation: readerCancellation.signal,
        controller,
      }),
    cancel: () => readerCancellation.abort(),
  })

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  })
}

type Transmission = {
  store: Conversations
  sign: SignLink
  threadID: string
  resumeFrom: string | null
  signal: AbortSignal
  readerCancellation: AbortSignal
  controller: ReadableStreamDefaultController<Uint8Array>
}

const transmitEvents = async (stream: Transmission): Promise<void> => {
  const encoder = new EventEncoder()
  const bytes = new TextEncoder()

  const sendEvents = (events: Event[], cursor: string) => {
    if (stream.signal.aborted) return

    // One durable change can produce several frames. Advance the cursor on the last
    // frame so reconnect cannot skip an unfinished bundle; starts and snapshots replace by ID.
    const frames = events
      .map(
        (event, index) =>
          `${index === events.length - 1 ? `id: ${cursor}\n` : ''}${encoder.encode(event)}`,
      )
      .join('')
    stream.controller.enqueue(bytes.encode(frames))
  }

  try {
    await followConversation(stream, sendEvents)
  } catch (error) {
    if (!stream.signal.aborted) {
      stream.controller.error(error)
      return
    }
    // An aborted request still needs close() if its in-flight query also failed.
  }

  if (!stream.readerCancellation.aborted) stream.controller.close()
}

/** Begin with one consistent projection, or resume strictly after the browser's saved cursor. */
const followConversation = async (
  stream: Transmission,
  sendEvents: (events: Event[], cursor: string) => void,
): Promise<void> => {
  let cursor = stream.resumeFrom

  // A resumed browser already has its projection; replaying a snapshot would reset partial text.
  if (cursor === null) {
    const snapshot = await stream.store.snapshot(stream.threadID)
    sendEvents(await snapshotEvents(snapshot, stream.sign, stream.threadID), snapshot.cursor)
    cursor = snapshot.cursor
  }

  while (!stream.signal.aborted) {
    const changes = await stream.store.changes({ threadID: stream.threadID, after: cursor })
    for (const change of changes) {
      sendEvents(await changeEvents(change.change, stream.sign, stream.threadID), change.cursor)
      cursor = change.cursor
    }

    await Bun.sleep(100)
  }
}
