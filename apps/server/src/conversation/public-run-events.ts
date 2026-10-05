import { EventType, type Event } from '@ag-ui/core'
import type { ExecutionEvent } from '@vid/contract/execution'

export type PublicRunState = Readonly<{
  started: boolean
  terminal: boolean
  messages: ReadonlyMap<string, string>
}>

// Each subscription reconstructs from canonical facts. No state is shared across
// readers, and transitions never mutate the caller's previous replay state.
export function mapPublicRunEvent(
  state: PublicRunState,
  fact: ExecutionEvent,
): {
  state: PublicRunState
  frames: Event[]
} {
  const messages = new Map(state.messages)
  const frames: Event[] = []
  if (!state.started)
    frames.push({
      type: EventType.RUN_STARTED,
      threadId: fact.threadID,
      runId: fact.runID,
    })

  let terminal = state.terminal
  switch (fact.kind) {
    case 'run-started':
      break
    case 'assistant-text':
      frames.push(...textFrames(messages, fact))
      messages.set(
        fact.messageID,
        (messages.get(fact.messageID) ?? '') + fact.delta,
      )
      break
    case 'run-completed': {
      frames.push(...textFrames(messages, fact))
      messages.set(fact.messageID, fact.text)
      frames.push(
        { type: EventType.TEXT_MESSAGE_END, messageId: fact.messageID },
        {
          type: EventType.RUN_FINISHED,
          threadId: fact.threadID,
          runId: fact.runID,
          outcome: { type: 'success' },
        },
      )
      terminal = true
      break
    }
    case 'run-cancelled':
    case 'run-failed':
      for (const messageId of messages.keys())
        frames.push({ type: EventType.TEXT_MESSAGE_END, messageId })
      frames.push(
        fact.kind === 'run-cancelled'
          ? {
              type: EventType.RUN_FINISHED,
              threadId: fact.threadID,
              runId: fact.runID,
              outcome: { type: 'cancelled' },
            }
          : {
              type: EventType.RUN_ERROR,
              code: fact.reason,
              message: failureMessage(fact.reason),
            },
      )
      terminal = true
      break
    default:
      assertNever(fact)
  }

  return {
    state: { started: true, terminal, messages },
    frames: frames.map((frame) => ({
      ...frame,
      metadata: {
        mappingVersion: 'ag-ui-1.0.1-v1',
        eventID: `${fact.eventID}:${frame.type}:${'messageId' in frame ? frame.messageId : ''}`,
        factID: fact.eventID,
      },
    })),
  }
}

function textFrames(
  messages: ReadonlyMap<string, string>,
  fact: Extract<ExecutionEvent, { kind: 'assistant-text' | 'run-completed' }>,
): Event[] {
  const frames: Event[] = []
  const previous = messages.get(fact.messageID)
  if (previous === undefined)
    frames.push({
      type: EventType.TEXT_MESSAGE_START,
      messageId: fact.messageID,
      role: 'assistant',
    })

  const delta =
    fact.kind === 'assistant-text'
      ? fact.delta
      : completionSuffix(previous ?? '', fact.text)
  if (delta)
    frames.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: fact.messageID,
      delta,
    })
  return frames
}

function completionSuffix(previous: string, text: string) {
  // Completion is canonical, not a delta. AG-UI cannot retract draft text;
  // a non-prefix correction is reconciled from the durable product snapshot.
  return text.startsWith(previous) ? text.slice(previous.length) : ''
}

function failureMessage(
  reason: Extract<ExecutionEvent, { kind: 'run-failed' }>['reason'],
) {
  switch (reason) {
    case 'execution-error':
      return 'The run could not finish. Check Chat history and ask the operator to verify the execution environment before retrying.'
    case 'sandbox-recovery-required':
      return 'The execution environment needs recovery before another run.'
    case 'interrupted':
      return 'The run was interrupted. Check Chat history and ask the operator to verify the execution environment before retrying.'
    default:
      return assertNever(reason)
  }
}

function assertNever(fact: never): never {
  throw new Error(`Unexpected public run event: ${String(fact)}`)
}
