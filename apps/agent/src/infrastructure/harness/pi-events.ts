import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'
import type { HarnessInput } from '../../application/ports/harness'
import type { Observation } from '../../domain/progress'
import type { createAnnouncements } from './announcements'

export const relayEvents = (
  session: AgentSession,
  input: HarnessInput,
  announcements: ReturnType<typeof createAnnouncements>,
): (() => void) => {
  let messageIndex = 0
  const filterThinking = createThinkingFilter()

  return session.subscribe((event) => {
    if (event.type === 'message_start') {
      messageIndex += 1
      return
    }

    if (event.type === 'message_update') {
      const messageID = `${input.turnID}:${messageIndex}`
      const observations = assistantObservations(
        event.assistantMessageEvent,
        messageID,
        filterThinking,
      )
      for (const observation of observations) input.onObservation(observation)
      return
    }

    if (event.type === 'tool_execution_update') {
      for (const announced of announcements.fromOutput(toolOutputText(event.partialResult))) {
        input.onObservation(announced)
      }
    }
  })
}

const assistantObservations = (
  event: AssistantEvent,
  messageID: string,
  filterThinking: (delta: string) => string,
): readonly Observation[] => {
  const contentID = 'contentIndex' in event ? `${messageID}:${event.contentIndex}` : messageID

  if (event.type === 'text_start') {
    return [{ kind: 'text-start', channel: 'assistant', messageID: contentID }]
  }
  if (event.type === 'text_delta') {
    const delta = filterThinking(event.delta)
    return delta === ''
      ? []
      : [{ kind: 'text-delta', channel: 'assistant', messageID: contentID, delta }]
  }
  if (event.type === 'text_end') {
    return [{ kind: 'text-end', channel: 'assistant', messageID: contentID }]
  }
  return reasoningObservations(event, contentID)
}

const reasoningObservations = (
  event: AssistantEvent,
  contentID: string,
): readonly Observation[] => {
  if (event.type === 'thinking_start') {
    return [{ kind: 'text-start', channel: 'reasoning', messageID: contentID }]
  }
  if (event.type === 'thinking_delta') {
    return [{ kind: 'text-delta', channel: 'reasoning', messageID: contentID, delta: event.delta }]
  }
  if (event.type === 'thinking_end') {
    return [{ kind: 'text-end', channel: 'reasoning', messageID: contentID }]
  }
  return []
}

/**
 * Some providers put reasoning tags inside ordinary text deltas. Hold a possible tag
 * suffix until the next delta decides it; publishing it early can expose reasoning.
 */
export const createThinkingFilter = (): ((delta: string) => string) => {
  let insideThinking = false
  let pending = ''

  return (delta) => {
    let text = pending + delta
    pending = ''
    let visibleText = ''

    while (text !== '') {
      const delimiter = insideThinking ? CLOSE_THINKING : OPEN_THINKING
      const delimiterAt = text.indexOf(delimiter)

      if (delimiterAt === -1) {
        const pendingLength = partialTagLength(text, delimiter)
        pending = text.slice(text.length - pendingLength)
        visibleText += insideThinking ? '' : text.slice(0, text.length - pendingLength)
        break
      }

      visibleText += insideThinking ? '' : text.slice(0, delimiterAt)
      text = text.slice(delimiterAt + delimiter.length)
      insideThinking = !insideThinking
    }

    return visibleText
  }
}

const OPEN_THINKING = '<thinking>'
const CLOSE_THINKING = '</thinking>'

const partialTagLength = (text: string, tag: string): number => {
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) {
    if (text.endsWith(tag.slice(0, length))) return length
  }
  return 0
}

const ToolText = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
})

const toolOutputText = (partial: unknown): string => {
  const parsed = ToolText.safeParse(partial)
  if (!parsed.success) return ''

  return parsed.data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

type SessionEvent = Parameters<Parameters<AgentSession['subscribe']>[0]>[0]
type AssistantEvent = Extract<SessionEvent, { type: 'message_update' }>['assistantMessageEvent']
