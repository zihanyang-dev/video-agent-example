/**
 * pi's event stream, in AG-UI.
 *
 * Half of the pi adapter, and the half that changes for a different reason: assembling a
 * session changes when a provider or a setting does, this changes when pi's stream does.
 * Both stay inside `harness/`, so pi's vocabulary still stops at this directory.
 *
 * pi carries no stable message id -- an assistant message has a model and a timestamp but
 * no identity -- so one is minted per turn. `contentIndex` separates spans within a
 * message; the counter separates messages within a turn.
 */
import { EventType, type Event } from '@ag-ui/core'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'
import type { HarnessInput } from './harness'

/** Returns the way to stop listening, which is the caller's to hold (code-style §8). */
export const relayEvents = (session: AgentSession, input: HarnessInput): (() => void) => {
  let messageIndex = 0

  return session.subscribe((event) => {
    if (event.type === 'message_start') {
      messageIndex += 1
      return
    }
    if (event.type === 'message_update') {
      const id = `${input.turnID}:${messageIndex}`
      for (const translated of fromAssistant(event.assistantMessageEvent, id)) {
        input.onEvent(translated)
      }
      return
    }
    if (event.type === 'tool_execution_update') {
      for (const announced of input.projection.fromOutput(textOf(event.partialResult))) {
        input.onEvent(announced)
      }
    }
    // Everything else produces nothing. Not a gap -- that is the rule (architecture.md §6).
  })
}

const fromAssistant = (event: AssistantEvent, id: string): readonly Event[] => {
  const messageId = 'contentIndex' in event ? `${id}:${event.contentIndex}` : id

  if (event.type === 'text_start') {
    return [{ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }]
  }
  if (event.type === 'text_delta') {
    return [{ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: strip(event.delta) }]
  }
  if (event.type === 'text_end') {
    return [{ type: EventType.TEXT_MESSAGE_END, messageId }]
  }
  return fromReasoning(event, messageId)
}

/**
 * Reasoning has its own channel, and that is the point: it must never arrive as message
 * text. It is shown while a turn runs and never stored -- the model's working notes are not
 * the conversation (architecture.md §3).
 */
const fromReasoning = (event: AssistantEvent, messageId: string): readonly Event[] => {
  if (event.type === 'thinking_start') {
    return [{ type: EventType.REASONING_MESSAGE_START, messageId, role: 'reasoning' }]
  }
  if (event.type === 'thinking_delta') {
    return [{ type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta: event.delta }]
  }
  if (event.type === 'thinking_end') {
    return [{ type: EventType.REASONING_MESSAGE_END, messageId }]
  }
  return []
}

/**
 * Some gateways inline reasoning into message text as a `<thinking>` block instead of
 * sending it on the reasoning channel. Observed once in three real runs against an
 * OpenAI-compatible endpoint. Rare is not good enough: a person seeing the model's private
 * working once is an incident, so it is removed here rather than hoped about.
 */
const strip = (delta: string): string => delta.replace(/<\/?thinking>/g, '')

/**
 * A tool's partial result is untyped on pi's side, so it is parsed rather than asserted --
 * this is a tool's JSON crossing into our code, which is exactly where §4.1 puts runtime
 * validation. Anything that does not match is simply not output a person could be shown.
 */
const ToolText = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
})

const textOf = (partial: unknown): string => {
  const parsed = ToolText.safeParse(partial)
  if (!parsed.success) return ''

  return parsed.data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

type AssistantEvent =
  Parameters<Parameters<AgentSession['subscribe']>[0]> extends [infer E]
    ? E extends { type: 'message_update'; assistantMessageEvent: infer A }
      ? A
      : never
    : never
