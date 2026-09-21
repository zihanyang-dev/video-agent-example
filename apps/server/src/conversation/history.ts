/**
 * What a page load gets.
 *
 * One AG-UI `MESSAGES_SNAPSHOT` of everything stored. Most of it needs no translation: the
 * durable record is already in the protocol's own shape (architecture.md §3).
 *
 * Artifacts are the exception, and the reason this is a module rather than one line. What
 * is written down is the object's key, because that stays true; what a browser can use is a
 * signed link, which stops working in an hour. So the link is minted here, at the moment
 * someone asks -- a link put in the record last night is a dead link this morning.
 *
 * Deltas are not here and never were. Five hundred fragments of a reply that finished
 * yesterday are not something to replay -- what was stored is what completed.
 */
import { EventType, type Event, type Message } from '@ag-ui/core'
import { ARTIFACT } from '@vid/contract'
import { StoredArtifact } from '@vid/store'

/** Mints a link for one object. `Files.downloadUrl`, and nothing else about storage. */
export type SignLink = (key: string) => Promise<string>

export const snapshotOf = async (messages: readonly Message[], sign: SignLink): Promise<Event> => ({
  type: EventType.MESSAGES_SNAPSHOT,
  messages: await Promise.all(messages.map((message) => readable(message, sign))),
})

/**
 * A stored message as a person may receive it.
 *
 * A record whose artifact cannot be signed is returned as it is rather than dropped: the
 * rest of the conversation is still worth reading, and one dead thumbnail is a better page
 * than no page.
 */
const readable = async (message: Message, sign: SignLink): Promise<Message> => {
  if (message.role !== 'activity' || message.activityType !== ARTIFACT) return message

  const stored = StoredArtifact.safeParse(message.content)
  if (!stored.success) return message

  return {
    ...message,
    content: { url: await sign(stored.data.key), role: stored.data.role },
  }
}
