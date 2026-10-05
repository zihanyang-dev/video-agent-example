import {
  messageSubmissionSchema,
  threadCreationSchema,
  runCancellationSchema,
} from '@vid/contract/http'

export const pendingIntentRecoveryMessage =
  'Saved pending request could not be decoded. Check Chat history before clearing browser data.'

type MessageInput = { text: string; assetIDs: string[] }
type Run = { threadID: string; runID: string }

// These records contain public intent only, never session tokens or auth models.
// Storage failure blocks the first write instead of silently weakening replay.
export function pendingIntents(userID: string, storage?: Storage) {
  if (storage === undefined) {
    try {
      storage = globalThis.localStorage
    } catch {
      storage = undefined
    }
  }
  const prefix = `frame:intent:${encodeURIComponent(userID)}:`
  function read<T>(key: string, decode: (value: unknown) => T): T | undefined {
    try {
      const saved = storage?.getItem(prefix + key) ?? null
      return saved === null ? undefined : decode(JSON.parse(saved))
    } catch {
      // Retain the original bytes and block replacement IDs. Private parser
      // diagnostics are not useful recovery instructions for an unknown receipt.
      throw new Error(pendingIntentRecoveryMessage)
    }
  }
  const readMessage = (threadID: string) =>
    read(`message:${threadID}`, (value) => messageSubmissionSchema.parse(value))
  const readCreation = () =>
    read('creation', (value) => threadCreationSchema.parse(value))
  return {
    readMessage,
    readCreation,
    message(threadID: string, input: MessageInput) {
      const saved = readMessage(threadID)
      if (saved) return saved
      if (!storage)
        throw new Error('Persistent browser storage is unavailable.')
      const intent = messageSubmissionSchema.parse({
        messageID: crypto.randomUUID(),
        ...input,
      })
      storage?.setItem(`${prefix}message:${threadID}`, JSON.stringify(intent))
      return intent
    },
    creation(title: string) {
      const saved = readCreation()
      if (saved) return saved
      if (!storage)
        throw new Error('Persistent browser storage is unavailable.')
      const intent = threadCreationSchema.parse({
        threadID: crypto.randomUUID(),
        title,
      })
      storage?.setItem(`${prefix}creation`, JSON.stringify(intent))
      return intent
    },
    cancellation(run: Run) {
      const saved = read(`cancel:${run.threadID}:${run.runID}`, (value) =>
        runCancellationSchema.parse(value),
      )
      if (saved) return saved
      if (!storage)
        throw new Error('Persistent browser storage is unavailable.')
      const intent = runCancellationSchema.parse({
        commandID: crypto.randomUUID(),
      })
      storage?.setItem(
        `${prefix}cancel:${run.threadID}:${run.runID}`,
        JSON.stringify(intent),
      )
      return intent
    },
    acceptMessage(threadID: string) {
      storage?.removeItem(`${prefix}message:${threadID}`)
    },
    acceptCreation() {
      storage?.removeItem(`${prefix}creation`)
    },
  }
}
