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
  const emit = (frame: Event) => {
    frames.push({
      ...frame,
      metadata: {
        mappingVersion: 'ag-ui-1.0.1-v1',
        eventID: `${fact.eventID}:${frame.type}:${'messageId' in frame ? frame.messageId : ''}`,
        factID: fact.eventID,
      },
    })
  }
  if (!state.started)
    emit({
      type: EventType.RUN_STARTED,
      threadId: fact.threadID,
      runId: fact.runID,
    })

  const terminal = appendFact({ messages, emit }, fact)
  return {
    state: { started: true, terminal: state.terminal || terminal, messages },
    frames,
  }
}

type FrameEmission = Readonly<{
  messages: Map<string, string>
  emit: (frame: Event) => void
}>

function beginMessage(emission: FrameEmission, messageID: string) {
  if (emission.messages.has(messageID)) return
  emission.messages.set(messageID, '')
  emission.emit({
    type: EventType.TEXT_MESSAGE_START,
    messageId: messageID,
    role: 'assistant',
  })
}

function appendFact(emission: FrameEmission, fact: ExecutionEvent): boolean {
  switch (fact.kind) {
    case 'run-started':
      return false
    case 'assistant-text':
      beginMessage(emission, fact.messageID)
      emission.messages.set(
        fact.messageID,
        (emission.messages.get(fact.messageID) ?? '') + fact.delta,
      )
      if (fact.delta)
        emission.emit({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: fact.messageID,
          delta: fact.delta,
        })
      return false
    case 'run-completed':
      completeMessage(emission, fact)
      emission.emit(finished(fact, 'success'))
      return true
    case 'run-cancelled':
      endMessages(emission)
      emission.emit(finished(fact, 'cancelled'))
      return true
    case 'run-failed':
      endMessages(emission)
      emission.emit({
        type: EventType.RUN_ERROR,
        code: fact.reason,
        message: failureMessage(fact.reason),
      })
      return true
    default:
      return assertNever(fact)
  }
}

function completeMessage(
  emission: FrameEmission,
  fact: Extract<ExecutionEvent, { kind: 'run-completed' }>,
) {
  beginMessage(emission, fact.messageID)
  const previous = emission.messages.get(fact.messageID) ?? ''
  // Completion is canonical, not a delta. AG-UI cannot retract draft text;
  // a non-prefix correction is reconciled from the durable product snapshot.
  const suffix = fact.text.startsWith(previous)
    ? fact.text.slice(previous.length)
    : ''
  if (suffix)
    emission.emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: fact.messageID,
      delta: suffix,
    })
  emission.messages.set(fact.messageID, fact.text)
  emission.emit({ type: EventType.TEXT_MESSAGE_END, messageId: fact.messageID })
}

function endMessages(emission: FrameEmission) {
  for (const messageId of emission.messages.keys())
    emission.emit({ type: EventType.TEXT_MESSAGE_END, messageId })
}

function finished(
  fact: ExecutionEvent,
  outcome: 'success' | 'cancelled',
): Event {
  return {
    type: EventType.RUN_FINISHED,
    threadId: fact.threadID,
    runId: fact.runID,
    outcome: { type: outcome },
  }
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
