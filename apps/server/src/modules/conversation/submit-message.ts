import { randomUUID } from 'node:crypto'

// IDs and field types are validated at the inbound boundary, not here.
export type SubmitMessageInput = {
  readonly ownerID: string
  readonly threadID: string
  readonly messageID: string
  readonly text: string
}

export type MessageIntent = SubmitMessageInput & {
  readonly commandID: string
  readonly runID: string
}

export type SubmitIntentOutcome =
  | {
      readonly kind: 'accepted'
      readonly messageID: string
      readonly commandID: string
      readonly runID: string
    }
  // Missing and foreign threads share one outcome to avoid leaking existence.
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'conflict' }

export type SubmitMessageOutcome =
  SubmitIntentOutcome | { readonly kind: 'invalid-input' }

export interface ConversationWrites {
  // Atomically authorize and save the message and pending execution intent.
  // Identical retries return the original IDs, not these candidate IDs;
  // conflicting message/command IDs never overwrite an accepted intent.
  submit: (intent: MessageIntent) => Promise<SubmitIntentOutcome>
}

export async function submitMessage(
  writes: ConversationWrites,
  input: SubmitMessageInput,
): Promise<SubmitMessageOutcome> {
  const text = input.text.trim()
  if (text.length === 0) return { kind: 'invalid-input' }

  // These are candidate IDs; only persistence can return accepted identities.
  return await writes.submit({
    ownerID: input.ownerID,
    threadID: input.threadID,
    messageID: input.messageID,
    text,
    commandID: randomUUID(),
    runID: randomUUID(),
  })
}
