import type { ExecutionEvent } from '@vid/contract/execution'

function isTerminal(event: ExecutionEvent): boolean {
  return (
    event.kind === 'run-completed' ||
    event.kind === 'run-cancelled' ||
    event.kind === 'run-failed'
  )
}

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

export type PublicReceipt = Readonly<{
  event: ExecutionEvent
  ordinal: bigint
  processed: boolean
}>

// A terminal can arrive before the gap closes. Its canonical message is stored
// immediately, but replay must wait for contiguous receipts and suppress drafts
// once the full answer is known. Arrival order must never allocate replay order.
export function planPublicReceipts(facts: readonly PublicReceipt[]):
  | { kind: 'conflict' }
  | {
      kind: 'ready'
      publications: Array<{ eventID: string; suppressed: boolean }>
    } {
  const messages = new Set(
    facts.flatMap((fact) =>
      'messageID' in fact.event ? [fact.event.messageID] : [],
    ),
  )
  if (messages.size > 1) return { kind: 'conflict' }
  const terminals = facts.filter((fact) => isTerminal(fact.event))
  if (terminals.length > 1) return { kind: 'conflict' }
  const terminal = terminals[0]
  const publications: Array<{ eventID: string; suppressed: boolean }> = []
  let expected = 1n
  for (const fact of facts) {
    if (fact.ordinal !== expected) break
    expected += 1n
    if (fact.processed) continue
    publications.push({
      eventID: fact.event.eventID,
      suppressed:
        terminal !== undefined &&
        (fact.event.kind === 'assistant-text' ||
          fact.ordinal > terminal.ordinal),
    })
  }
  return { kind: 'ready', publications }
}

function assertNever(event: never): never {
  throw new Error(`Unexpected execution receipt: ${String(event)}`)
}
