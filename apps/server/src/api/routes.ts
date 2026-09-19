/**
 * Inbound HTTP: what a browser can ask for.
 *
 * A boundary. It declares the contract, checks who is asking, turns a request into a queue
 * entry or a stream, and translates one outcome into one status code. Nothing here decides
 * a product rule -- whether a person may read a thread is `conversation/thread.ts`, what a
 * page load contains is `conversation/history.ts`.
 *
 * It does not wait for a turn. Posting a message returns as soon as the work is queued: a
 * turn runs for minutes and an HTTP request that lived that long would be holding a
 * connection open across a deploy (architecture.md §1).
 */
import type { TurnQueue } from '@vid/queue'
import type { LiveStream, Messages } from '@vid/store'
import { Hono } from 'hono'
import { mayRead, NOT_READABLE, type Reader } from '../conversation/thread'
import { streamConversation } from './sse'

export type ApiParts = {
  queue: TurnQueue
  messages: Messages
  live: LiveStream
  /** Null when the request carries no usable session. */
  readerOf: (request: Request) => Promise<Reader | null>
  /** Ids are minted here so a caller cannot choose one and collide with another turn. */
  newTurnID: () => string
}

export const createRoutes = (parts: ApiParts): Hono => {
  const app = new Hono()

  app.get('/threads/:thread/events', async (context) => {
    const reader = await parts.readerOf(context.req.raw)
    if (reader === null) return context.text('sign in', 401)

    const threadID = context.req.param('thread')
    const thread = await parts.messages.thread(threadID)
    if (!mayRead(thread, reader)) return context.text(NOT_READABLE, 404)

    // A reconnect says where it got to. The browser sends this header on its own.
    const resumeFrom = context.req.header('last-event-id') ?? null

    return streamConversation(
      { live: parts.live, messages: parts.messages },
      threadID,
      resumeFrom,
      context.req.raw.signal,
    )
  })

  app.post('/threads/:thread/messages', async (context) => {
    const reader = await parts.readerOf(context.req.raw)
    if (reader === null) return context.text('sign in', 401)

    const threadID = context.req.param('thread')
    const thread = await parts.messages.thread(threadID)
    if (!mayRead(thread, reader)) return context.text(NOT_READABLE, 404)

    const said = await spoken(context.req.raw)
    if (said === null) return context.text('a message is required', 400)

    const turnID = parts.newTurnID()
    await parts.queue.put({ threadID, userID: reader.userID, turnID, message: said })

    // Accepted, not done. The answer arrives on the event stream.
    return context.json({ turnID }, 202)
  })

  return app
}

/** Null for anything that is not a message a person typed. */
const spoken = async (request: Request): Promise<string | null> => {
  try {
    const body = (await request.json()) as { message?: unknown }
    if (typeof body.message !== 'string' || body.message.trim() === '') return null

    return body.message
  } catch {
    // Not JSON at all. One recovery -- send a message -- so it is one error.
    return null
  }
}
