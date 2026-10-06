import {
  CURRENT_SESSION_VERSION,
  parseSessionEntries,
  SessionManager,
  type SessionEntry,
  type SessionHeader,
} from '@earendil-works/pi-coding-agent'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireHistory(valid: unknown): asserts valid {
  if (!valid) {
    throw new Error('Invalid private Pi history')
  }
}

function validateHeader(header: SessionHeader): void {
  requireHistory(
    header.version === CURRENT_SESSION_VERSION &&
      typeof header.id === 'string' &&
      header.id.length > 0 &&
      typeof header.cwd === 'string' &&
      typeof header.timestamp === 'string',
  )
}

function decodeHistory(history: unknown) {
  requireHistory(object(history))
  requireHistory(object(history.header) && Array.isArray(history.entries))
  requireHistory(history.leafID === null || typeof history.leafID === 'string')
  // Use the official decoder/types, not a shadow session or provider schema.
  const decoded = parseSessionEntries(
    [history.header, ...history.entries]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  requireHistory(decoded.length === history.entries.length + 1)
  const [header, ...entries] = decoded
  requireHistory(header?.type === 'session')
  validateHeader(header)
  return { decoded, header, entries, leafID: history.leafID }
}

function validateContext(message: unknown): void {
  // Replay dereferences the message and iterates content. Missing content is
  // explicitly normalized by the SDK; provider metadata/blocks remain opaque.
  requireHistory(object(message))
  const { content } = message
  requireHistory(
    content === undefined ||
      content === null ||
      typeof content === 'string' ||
      Array.isArray(content),
  )
  if (message.role === 'system' && message.sections !== undefined) {
    requireHistory(object(message.sections))
    requireHistory(
      Object.values(message.sections).every(
        (section) => section === null || typeof section === 'string',
      ),
    )
  }
}

function indexEntries(entries: ReturnType<typeof parseSessionEntries>) {
  const byID = new Map<string, SessionEntry>()
  for (const entry of entries) {
    requireHistory(object(entry) && entry.type !== 'session')
    requireHistory(
      typeof entry.id === 'string' &&
        entry.id.length > 0 &&
        !byID.has(entry.id) &&
        (entry.parentId === null || typeof entry.parentId === 'string'),
    )
    if (entry.type === 'message') {
      validateContext(entry.message)
    }
    byID.set(entry.id, entry)
  }
  return byID
}

function validateReferences(byID: Map<string, SessionEntry>): void {
  for (const entry of byID.values()) {
    requireHistory(entry.parentId === null || byID.has(entry.parentId))
    if (entry.type === 'compaction') {
      requireHistory(byID.has(entry.firstKeptEntryId))
    }
    if (entry.type === 'branch_summary') {
      requireHistory(byID.has(entry.fromId))
    }
    if (entry.type === 'label' || entry.type === 'context_edit') {
      requireHistory(byID.has(entry.targetId))
    }
  }
}

function validateAcyclic(byID: Map<string, SessionEntry>): void {
  // Linear across every branch, including inactive ones. SDK traversal is
  // synchronous, so an AbortSignal cannot interrupt a corrupt parent cycle.
  const done = new Set<string>()
  for (const entry of byID.values()) {
    const path = new Set<string>()
    let current: SessionEntry | undefined = entry
    while (current && !done.has(current.id)) {
      requireHistory(!path.has(current.id))
      path.add(current.id)
      current =
        current.parentId === null ? undefined : byID.get(current.parentId)
    }
    for (const id of path) {
      done.add(id)
    }
  }
}

export class HistoryLimitError extends Error {}

// Logical admission: serialization allocates; this is not a transport/RSS cap.
export function admitPiHistory(history: unknown): void {
  const serialized = JSON.stringify(history)
  if (
    serialized !== undefined &&
    Buffer.byteLength(serialized) > 4 * 1024 * 1024
  ) {
    throw new HistoryLimitError('Private history size limit exceeded')
  }
}

export function restorePiHistory(history: unknown): SessionManager {
  admitPiHistory(history)
  // SQL's empty-array default is a fresh-session sentinel, not a session tree.
  if (
    history === null ||
    history === undefined ||
    (Array.isArray(history) && history.length === 0)
  ) {
    return SessionManager.inMemory()
  }
  const { decoded, header, entries, leafID } = decodeHistory(history)
  const byID = indexEntries(entries)
  requireHistory(leafID === null || byID.has(leafID))
  validateReferences(byID)
  validateAcyclic(byID)
  const manager = SessionManager.inMemory(header.cwd, undefined, decoded)
  if (leafID === null) {
    manager.resetLeaf()
  } else {
    manager.branch(leafID)
  }
  return manager
}
