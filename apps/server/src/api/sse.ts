/**
 * One conversation, streamed to one browser.
 *
 * The snapshot goes first and the live events follow. A browser that arrives mid-turn gets
 * what already happened and then keeps up, with no gap between the two: the cursor for the
 * live read is taken before the snapshot is built, so anything written in between arrives
 * as an event rather than being lost between the two reads.
 *
 * Every event carries its stream position as the SSE id. That is what a reconnect sends
 * back in `Last-Event-ID`, and it is why the stream is a Redis stream rather than a channel
 * -- laptops close and trains go into tunnels (architecture.md §3.1).
 */
import { EventEncoder } from '@ag-ui/encoder'
import type { Event } from '@ag-ui/core'
import type { LiveStream, Messages } from '@vid/store'
import { snapshotOf, type SignLink } from '../conversation/history'

export type StreamParts = {
  live: LiveStream
  messages: Messages
  /** Mints a link for a stored artifact. The record keeps a key; a browser needs a URL. */
  sign: SignLink
}

export const streamConversation = (
  parts: StreamParts,
  threadID: string,
  resumeFrom: string | null,
  signal: AbortSignal,
): Response => {
  const encoder = new EventEncoder()

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const bytes = new TextEncoder()
      const send = (event: Event, id?: string) => {
        const framed = encoder.encode(event)
        controller.enqueue(bytes.encode(id === undefined ? framed : `id: ${id}\n${framed}`))
      }

      try {
        // Only on a first connection. A reconnect already has everything up to its cursor,
        // and replaying the snapshot would make the page redraw what it is already showing.
        if (resumeFrom === null) {
          send(await snapshotOf(await parts.messages.read(threadID), parts.sign))
        }

        for await (const { id, event } of parts.live.read(
          { thread: threadID, after: resumeFrom },
          signal,
        )) {
          send(event, id)
        }
      } catch (error) {
        // The browser is gone, or Redis is. Either way the stream ends; a half-written
        // frame would be worse than a closed connection the client will retry.
        if (!signal.aborted) console.error(`stream for ${threadID} ended`, error)
      } finally {
        controller.close()
      }
    },
  })

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  })
}
