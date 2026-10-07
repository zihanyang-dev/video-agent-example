import { EventType, type Event } from '@ag-ui/core'
import type { ExecutionEvent } from '@vid/contract/execution'

export type PublicRunState = Readonly<{
  phase: 'unopened' | 'open' | 'terminal'
  messages: ReadonlyMap<string, string>
}>

// Each reader folds canonical facts independently. Reconstruction needs only
// this state, never discarded protocol frames or a second set of transition rules.
export function foldPublicRunEvent(state: PublicRunState, fact: ExecutionEvent): PublicRunState {
  if (state.phase === 'terminal') throw new Error('Cannot fold a fact after a terminal run')
  switch (fact.kind) {
    case 'run-started':
      return { ...state, phase: 'open' }
    case 'assistant-text': {
      const messages = new Map(state.messages)
      messages.set(fact.messageID, (messages.get(fact.messageID) ?? '') + fact.delta)
      return { phase: 'open', messages }
    }
    case 'run-completed': {
      const messages = new Map(state.messages)
      messages.set(fact.messageID, fact.text)
      return { phase: 'terminal', messages }
    }
    case 'run-cancelled':
    case 'run-failed':
      return { ...state, phase: 'terminal' }
    default:
      return assertNever(fact)
  }
}

/** Live delivery folds once and projects once. Terminal reconnects project the
 * already-folded canonical state without applying its terminal a second time. */
export function mapPublicRunEvent(state: PublicRunState, fact: ExecutionEvent) {
  const next = foldPublicRunEvent(state, fact)
  return { state: next, frames: projectPublicRunEvent(state, fact) }
}

export function projectPublicRunEvent(state: PublicRunState, fact: ExecutionEvent): Event[] {
  const frames: Event[] = []
  if (state.phase === 'unopened')
    frames.push({
      type: EventType.RUN_STARTED,
      threadId: fact.threadID,
      runId: fact.runID,
    })
  if ('messageID' in fact) frames.push(...textFrames(state.messages, fact))
  if (fact.kind !== 'run-started' && fact.kind !== 'assistant-text')
    frames.push(...terminalFrames(state.messages, fact))
  return frames.map((frame) => {
    const messageID = 'messageId' in frame ? frame.messageId : ''
    return {
      ...frame,
      metadata: {
        mappingVersion: 'ag-ui-1.0.1-v1',
        eventID: `${fact.eventID}:${frame.type}:${messageID}`,
        factID: fact.eventID,
      },
    }
  })
}

function terminalFrames(
  messages: ReadonlyMap<string, string>,
  fact: Extract<ExecutionEvent, { kind: 'run-completed' | 'run-cancelled' | 'run-failed' }>,
): Event[] {
  const messageIDs = fact.kind === 'run-completed' ? [fact.messageID] : [...messages.keys()]
  const ends: Event[] = messageIDs.map((messageId) => ({
    type: EventType.TEXT_MESSAGE_END,
    messageId,
  }))
  switch (fact.kind) {
    case 'run-completed':
      return [
        ...ends,
        {
          type: EventType.RUN_FINISHED,
          threadId: fact.threadID,
          runId: fact.runID,
          outcome: { type: 'success' },
        },
      ]
    case 'run-cancelled':
      return [
        ...ends,
        {
          type: EventType.RUN_FINISHED,
          threadId: fact.threadID,
          runId: fact.runID,
          outcome: { type: 'cancelled' },
        },
      ]
    case 'run-failed':
      return [
        ...ends,
        {
          type: EventType.RUN_ERROR,
          code: fact.reason,
          message: failureMessage(fact.reason),
        },
      ]
    default:
      return assertNever(fact)
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
    fact.kind === 'assistant-text' ? fact.delta : completionSuffix(previous ?? '', fact.text)
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

function failureMessage(reason: Extract<ExecutionEvent, { kind: 'run-failed' }>['reason']) {
  const recovery =
    'Check Chat history and ask the operator to verify the execution environment before retrying.'
  switch (reason) {
    case 'execution-error':
      return `The run could not finish. ${recovery}`
    case 'sandbox-recovery-required':
      return 'The execution environment needs recovery before another run.'
    case 'interrupted':
      return `The run was interrupted. ${recovery}`
    default:
      return assertNever(reason)
  }
}

function assertNever(fact: never): never {
  throw new Error(`Unexpected public run event: ${String(fact)}`)
}
