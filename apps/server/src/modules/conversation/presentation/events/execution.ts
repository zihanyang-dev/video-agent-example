import { ExecutionEvent } from '@vid/contract/execution'
import type { ExecutionResults } from '../../application/ports/execution-results'
import type { ExecutionUpdate } from '../../domain/execution-result'

/** Decode the cross-process contract once and translate activity updates into product facts. */
export const receiveExecution =
  (results: ExecutionResults) =>
  async (body: unknown): Promise<boolean> => {
    const event = ExecutionEvent.parse(body)
    const progress = event.progress

    let update: ExecutionUpdate
    if (
      progress.kind === 'plan' ||
      progress.kind === 'step' ||
      progress.kind === 'ask' ||
      progress.kind === 'artifact'
    ) {
      const { messageID, ...activity } = progress
      update = { kind: 'activity', messageID, activity }
    } else {
      update = progress
    }

    return results.apply({
      eventID: event.eventID,
      threadID: event.threadID,
      turnID: event.turnID,
      sequence: event.sequence,
      update,
    })
  }
