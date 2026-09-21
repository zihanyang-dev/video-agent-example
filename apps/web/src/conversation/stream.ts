/**
 * The browser's half of the conversation: an adapter, and the only file here that knows how
 * to reach the server.
 *
 * Reading and writing are separate calls to separate endpoints, which is not an accident.
 * Posting a message returns as soon as the work is queued -- a turn runs for minutes, and a
 * request that waited for one would be holding a connection open across a deploy. The answer
 * arrives on the stream (architecture.md §1).
 *
 * `EventSource` rather than a hand-rolled reader over `fetch`: it reconnects on its own and
 * sends `Last-Event-ID` when it does, which is exactly the resume the server implements.
 * A reader we wrote would be a reconnect policy we maintain.
 */
import type { Event } from '@ag-ui/core'
import { EventSchema } from '@ag-ui/core/schemas'

export type Conversation = {
  /** Stops listening. The server sees the connection close and stops reading Redis. */
  close: () => void
}

export const listen = (
  threadID: string,
  onEvent: (event: Event) => void,
  onTrouble: (reachable: boolean) => void,
): Conversation => {
  const source = new EventSource(`/api/threads/${threadID}/events`)

  source.addEventListener('open', () => onTrouble(true))

  // Fires on a dropped connection as well as a refused one, and `EventSource` retries by
  // itself afterwards. So this says "not right now", never "give up".
  source.addEventListener('error', () => onTrouble(false))

  source.addEventListener('message', (message: MessageEvent<string>) => {
    const parsed = safely(message.data)

    // Validated rather than asserted. This arrives from another process across a network,
    // and a build that drifted would otherwise show up as a crash inside a component.
    const event = parsed === null ? null : EventSchema.safeParse(parsed)
    if (event === null || !event.success) {
      console.warn('an event arrived that this build does not understand', message.data)
      return
    }

    onEvent(event.data as Event)
  })

  return { close: () => source.close() }
}

export const say = async (threadID: string, message: string): Promise<void> => {
  const answered = await fetch(`/api/threads/${threadID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  })

  if (!answered.ok) throw new Error(await answered.text())
}

export const stopWork = async (threadID: string): Promise<void> => {
  const answered = await fetch(`/api/threads/${threadID}/stop`, { method: 'POST' })
  if (!answered.ok) throw new Error(await answered.text())
}

export const openConversation = async (): Promise<string> => {
  const answered = await fetch('/api/threads', { method: 'POST' })
  if (!answered.ok) throw new Error(await answered.text())

  return ((await answered.json()) as { threadID: string }).threadID
}

const safely = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
