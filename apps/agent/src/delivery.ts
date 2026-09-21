/**
 * Where a visible event goes.
 *
 * Two destinations with different units: the stream carries fragments to whoever is
 * watching, the database carries completed things to whoever arrives tomorrow
 * (architecture.md §3.1).
 *
 * Split out of the turn because it is a different question. A turn is about a lifetime --
 * rent a machine, run, give it back. This is about one event and the two shapes it leaves
 * in, and it needs none of the rest.
 */
import { EventType, type Event, type Message } from '@ag-ui/core'
import { ARTIFACT, ArtifactContent } from '@vid/contract'
import type { Files, LiveStream, Messages, StoredArtifact } from '@vid/store'
import type { Sandbox } from './sandbox/sandbox'
import { workspaceOf } from './workspace'

/** What delivery needs, which is less than a whole turn. */
export type DeliveryParts = {
  live: LiveStream
  messages: Messages
  files: Files
}

export type Delivery = {
  take: (event: Event) => void
  drain: () => Promise<void>
}

export const createDelivery = (
  parts: DeliveryParts,
  threadID: string,
  sandbox: Sandbox,
): Delivery => {
  const assembling = new Map<string, string>()

  // Two chains, because the two stores order differently. The stream is one connection and
  // keeps the order its commands were issued in; the database is a pool and does not --
  // measured, and what came back was shuffled, which on a reload is a conversation whose
  // turns have swapped places. So each write waits for the one before it.
  let published: Promise<unknown> = Promise.resolve()
  let stored: Promise<unknown> = Promise.resolve()

  const take = (event: Event): void => {
    // Resolved once, awaited by both chains, so the two stores never disagree about what an
    // event said.
    const ready = deliverable(parts, threadID, sandbox, event)

    published = published.then(async () => {
      const delivered = await ready
      if (delivered.event !== null) await parts.live.publish(threadID, delivered.event)
    })

    stored = stored.then(async () => {
      const delivered = await ready
      if (delivered.event === null) return

      const durable = keep(delivered, assembling)
      if (durable === null) return

      // An activity is written by its id however many times it is sent, and an id is stable
      // across turns by design -- that is what makes `running` and `done` one row rather
      // than two. Deciding append-or-replace from what this turn has seen got that wrong
      // the moment a second turn delivered the same thing: measured, the insert hit the
      // primary key, the chain behind it stopped, and that turn's reply never reached the
      // record at all, while the turn itself returned as though nothing had happened.
      await (durable.role === 'activity'
        ? parts.messages.replace(threadID, durable)
        : parts.messages.append(threadID, durable))
    })
  }

  /** Every write started during the turn has landed before the turn reports done. */
  const drain = async (): Promise<void> => {
    await Promise.all([published, stored])
  }

  return { take, drain }
}

/**
 * Turns what a script announced into what a person may receive. Null drops the event.
 *
 * Only artifacts need this. A script announces the workspace path of the thing it made --
 * it has no credential and cannot mint anything -- and the file leaves here as a short-lived
 * URL. The file is carried out now rather than at the end of the turn, because a person
 * watching sees the artifact appear and will click it immediately.
 *
 * A path that cannot be turned into a URL is dropped rather than forwarded. Passing it on
 * would put an internal path on a screen, which is the one thing the contract exists to
 * prevent, and a link to it would be a link to nothing anyway.
 */
const deliverable = async (
  parts: DeliveryParts,
  threadID: string,
  sandbox: Sandbox,
  event: Event,
): Promise<Delivered> => {
  if (event.type !== EventType.ACTIVITY_SNAPSHOT || event.activityType !== ARTIFACT) {
    return { event }
  }

  const announced = ArtifactContent.safeParse(event.content)
  if (!announced.success) return { event: null }

  const path = announced.data.url.replace(/^\/+/, '')
  const key = `${workspaceOf(threadID)}${path}`

  try {
    await parts.files.put(key, await sandbox.readFile(`${sandbox.roots.sandbox}/${path}`))
    return {
      event: { ...event, content: { ...announced.data, url: await parts.files.downloadUrl(key) } },
      // Carried separately rather than inside the event: the link is what a person receives
      // and the key is what gets written down, and they are different on purpose.
      stored: { key, role: announced.data.role },
    }
  } catch (error) {
    console.error(`turn on ${threadID}: announced ${path}, which could not be delivered`, error)
    return { event: null }
  }
}

/**
 * One event, in the two shapes it leaves in.
 *
 * `event` is what a person receives; `stored` is what the record keeps, and only artifacts
 * have one, because only artifacts carry something that expires.
 */
type Delivered = { event: Event | null; stored?: StoredArtifact }

/**
 * Null for anything a page reload should not replay.
 *
 * Text is assembled here because AG-UI's TEXT_MESSAGE_END carries no content -- it says a
 * message finished, not what it said.
 */
const keep = (delivered: Delivered, assembling: Map<string, string>): Message | null => {
  const event = delivered.event
  if (event === null) return null

  if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
    assembling.set(event.messageId, (assembling.get(event.messageId) ?? '') + event.delta)
    return null
  }

  if (event.type === EventType.TEXT_MESSAGE_END) {
    const text = assembling.get(event.messageId) ?? ''
    assembling.delete(event.messageId)
    return { id: event.messageId, role: 'assistant', content: text }
  }

  if (event.type === EventType.ACTIVITY_SNAPSHOT) {
    // A running step is not kept: tomorrow it would be a spinner nobody will ever stop.
    if (isRunning(event.content)) return null
    return {
      id: event.messageId,
      role: 'activity',
      activityType: event.activityType,
      // The stored shape when there is one. An artifact's link expires; its key does not.
      content: delivered.stored ?? event.content,
    }
  }

  return null
}

const isRunning = (content: Record<string, unknown>): boolean => content['state'] === 'running'
