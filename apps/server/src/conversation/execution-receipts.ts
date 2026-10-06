import type { ExecutionEvent } from '@vid/contract/execution'
import { webSourcesSchema } from '@vid/contract/web-source'

// Copy only the typed public contract; never persist private extra properties.
export function publicEvent(event: ExecutionEvent): ExecutionEvent {
  const identities = {
    version: event.version,
    eventID: event.eventID.toLowerCase(),
    threadID: event.threadID.toLowerCase(),
    runID: event.runID.toLowerCase(),
  }
  switch (event.kind) {
    case 'assistant-text':
      return {
        ...identities,
        kind: event.kind,
        messageID: event.messageID.toLowerCase(),
        delta: event.delta,
      }
    case 'run-completed':
      return {
        ...identities,
        kind: event.kind,
        messageID: event.messageID.toLowerCase(),
        text: event.text,
        ...(event.assets === undefined ? {} : { assets: event.assets }),
        ...(event.sources === undefined
          ? {}
          : { sources: webSourcesSchema.parse(event.sources) }),
      }
    case 'run-failed':
      return { ...identities, kind: event.kind, reason: event.reason }
    case 'run-started':
    case 'run-cancelled':
      return { ...identities, kind: event.kind }
    default:
      return assertNever(event)
  }
}

function assertNever(event: never): never {
  throw new Error(`Unexpected execution receipt: ${String(event)}`)
}
