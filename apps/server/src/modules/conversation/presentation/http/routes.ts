import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import type { Reader } from '../../domain/thread'
import type { Conversation } from '../../application/conversation'
import type { Conversations } from '../../application/ports/conversations'
import type { SignLink } from './history'
import { streamConversation } from './sse'

const MessageRequest = z.object({
  message: z.string().trim().min(1),
  commandID: z.string().min(1).optional(),
})
// Missing and private conversations share a response so callers cannot discover another user's IDs.
const NOT_READABLE = 'no such conversation'

export type ConversationHttpDependencies = {
  conversation: Conversation
  store: Conversations
  sign: SignLink
  readerOf: (request: Request) => Promise<Reader | null>
}

type Authenticated = { Variables: { reader: Reader } }

/** Bind HTTP operations and authentication; conversation use cases retain authorization. */
export const createRoutes = (dependencies: ConversationHttpDependencies): Hono<Authenticated> => {
  const app = new Hono<Authenticated>()
  const signedIn = requireReader(dependencies.readerOf)

  app.post('/threads', signedIn, openThread(dependencies.conversation))
  app.post('/threads/:thread/messages', signedIn, acceptMessage(dependencies.conversation))
  app.post('/threads/:thread/stop', signedIn, stopThread(dependencies.conversation))
  app.get('/threads/:thread/events', signedIn, subscribeToEvents(dependencies))

  return app
}

/** Attach identity only to registered operations, preserving 404 for unknown routes. */
const requireReader = (readerOf: ConversationHttpDependencies['readerOf']) =>
  createMiddleware<Authenticated>(async (context, next) => {
    const reader = await readerOf(context.req.raw)
    if (reader === null) return context.text('sign in', 401)

    context.set('reader', reader)
    await next()
  })

const openThread = (conversation: Conversation) => async (context: Context<Authenticated>) => {
  const threadID = await conversation.open(context.get('reader'))

  return context.json({ threadID }, 201)
}

/** A successful reply identifies the durable command, assigning its ID when the caller omits one. */
const acceptMessage =
  (conversation: Conversation) =>
  async (context: Context<Authenticated, '/threads/:thread/messages'>): Promise<Response> => {
    const message = MessageRequest.safeParse(await jsonBody(context.req.raw))
    if (!message.success) return context.text('a message is required', 400)

    const commandID = message.data.commandID ?? crypto.randomUUID()
    const accepted = await conversation.accept(context.get('reader'), {
      threadID: context.req.param('thread'),
      commandID,
      message: message.data.message,
    })

    if (accepted === 'inaccessible') return context.text(NOT_READABLE, 404)
    if (accepted === 'conflict')
      return context.text('command ID was already used for different input', 409)

    return context.json({ commandID }, 202)
  }

const stopThread =
  (conversation: Conversation) =>
  async (context: Context<Authenticated, '/threads/:thread/stop'>): Promise<Response> => {
    const canStop = await conversation.stop(context.get('reader'), context.req.param('thread'))

    return canStop ? context.body(null, 202) : context.text(NOT_READABLE, 404)
  }

/** Check access before cursor syntax so private conversation IDs remain undiscoverable. */
const subscribeToEvents =
  (dependencies: ConversationHttpDependencies) =>
  async (context: Context<Authenticated, '/threads/:thread/events'>): Promise<Response> => {
    const threadID = context.req.param('thread')
    const thread = await dependencies.conversation.access(context.get('reader'), threadID)
    if (thread === null) return context.text(NOT_READABLE, 404)

    const cursor = context.req.header('last-event-id') ?? null
    if (cursor !== null && !/^\d+$/.test(cursor)) return context.text('invalid event cursor', 400)

    return streamConversation(dependencies, threadID, cursor, context.req.raw.signal)
  }

const jsonBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json()
  } catch {
    // Malformed JSON has the same recovery as an invalid message.
    return null
  }
}
