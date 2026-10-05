// The HTTP boundary validates field types; owner IDs remain opaque and case-sensitive.
export type OwnedThread = Readonly<{ ownerID: string; threadID: string }>
export type SubmitMessageInput = OwnedThread &
  Readonly<{ messageID: string; text: string; assetIDs?: readonly string[] }>
export type MessageIntent = SubmitMessageInput &
  Readonly<{ commandID: string; runID: string }>
export type SubmitIntentOutcome =
  | {
      readonly kind: 'accepted'
      readonly messageID: string
      readonly commandID: string
      readonly runID: string
    }
  // Missing and foreign threads share recovery without disclosing existence.
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'conflict' }
export type SubmitMessageOutcome =
  SubmitIntentOutcome | { readonly kind: 'invalid-input' }

export function normalizeMessageIntent(
  intent: MessageIntent,
): MessageIntent | null {
  const text = intent.text.trim()
  if (!text && (intent.assetIDs ?? []).length === 0) return null
  return {
    ownerID: intent.ownerID,
    threadID: intent.threadID.toLowerCase(),
    messageID: intent.messageID.toLowerCase(),
    commandID: intent.commandID.toLowerCase(),
    runID: intent.runID.toLowerCase(),
    text,
    ...(intent.assetIDs === undefined
      ? {}
      : { assetIDs: intent.assetIDs.map((id) => id.toLowerCase()) }),
  }
}

export type AcceptedMessageFacts = Readonly<{
  threadID: string
  role: string
  assetIDs?: readonly string[]
  text: string
  commandID: string | null
  runID: string | null
}>

// Call only after locking the requested thread. Replay IDs belong to the durable
// message, not the retry's candidates; authorization must precede this decision.
export function decideMessageReplay(
  intent: MessageIntent,
  message: AcceptedMessageFacts | null,
): SubmitIntentOutcome | null {
  if (message === null) return null
  if (
    message.threadID !== intent.threadID ||
    message.role !== 'user' ||
    message.text !== intent.text ||
    JSON.stringify(message.assetIDs ?? []) !==
      JSON.stringify(intent.assetIDs ?? []) ||
    message.commandID === null ||
    message.runID === null
  )
    return { kind: 'conflict' }
  return {
    kind: 'accepted',
    messageID: intent.messageID,
    commandID: message.commandID,
    runID: message.runID,
  }
}

export function authorizeThread(
  ownerID: string,
  threadOwnerID: string | null,
): 'authorized' | 'unavailable' {
  return threadOwnerID === ownerID ? 'authorized' : 'unavailable'
}

export function authorizeCancellation(
  hasAcceptedStart: boolean,
): 'authorized' | 'unavailable' {
  return hasAcceptedStart ? 'authorized' : 'unavailable'
}

/** Archive denies new writes and their retries, but history and explicit stop
 * requests remain available. Foreign and absent threads share privacy recovery. */
export function decideThreadAccess(
  ownerID: string,
  thread: Readonly<{ ownerID: string | null; archived: boolean }> | null,
  action: 'read' | 'write' | 'cancel',
): 'authorized' | 'unavailable' | 'conflict' {
  if (
    thread === null ||
    authorizeThread(ownerID, thread.ownerID) === 'unavailable'
  )
    return 'unavailable'
  if (action === 'write' && thread.archived) return 'conflict'
  return 'authorized'
}
