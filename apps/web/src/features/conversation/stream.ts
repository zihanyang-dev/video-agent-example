import type { Event } from '@ag-ui/core'
import { EventSchema } from '@ag-ui/core/schemas'

type ConversationSubscription = {
  close: () => void
}

export const listen = (
  threadID: string,
  onEvent: (event: Event) => void,
  onConnectionChange: (isConnected: boolean) => void,
): ConversationSubscription => {
  const source = new EventSource(`/api/threads/${threadID}/events`)

  source.addEventListener('open', () => onConnectionChange(true))

  // Fires on a dropped connection as well as a refused one, and `EventSource` retries by
  // itself afterwards. So this says "not right now", never "give up".
  source.addEventListener('error', () => onConnectionChange(false))

  source.addEventListener('message', (message: MessageEvent<string>) => {
    const parsed = parseJson(message.data)

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

export const say = async (
  threadID: string,
  input: { commandID: string; message: string },
): Promise<void> => {
  const response = await fetch(`/api/threads/${threadID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) throw new Error(await response.text())
}

export const stopWork = async (threadID: string): Promise<void> => {
  const response = await fetch(`/api/threads/${threadID}/stop`, { method: 'POST' })
  if (!response.ok) throw new Error(await response.text())
}

export const openConversation = async (): Promise<string> => {
  const response = await fetch('/api/threads', { method: 'POST' })
  if (!response.ok) throw new Error(await response.text())

  return ((await response.json()) as { threadID: string }).threadID
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    // Malformed JSON follows the same reporting path as an unsupported event schema.
    return null
  }
}
