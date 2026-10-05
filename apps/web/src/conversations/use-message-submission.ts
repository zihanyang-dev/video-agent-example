import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { messageSubmissionSchema } from '@vid/contract/http'
import { errorMessage, HTTPError, apiForUser } from '../http'
import { submitMessage } from '@vid/contract/client'
import { pendingIntents, pendingIntentRecoveryMessage } from './pending-intents'
import { messagesQuery, type ThreadScope } from './queries'

type PendingMessage = ReturnType<typeof messageSubmissionSchema.parse>

export function useMessageSubmission(scope: ThreadScope) {
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])
  const client = useQueryClient()
  const intents = pendingIntents(scope.userID)
  const [restored] = useState(() => {
    try {
      return { pending: intents.readMessage(scope.threadID), error: '' }
    } catch {
      return { pending: undefined, error: pendingIntentRecoveryMessage }
    }
  })
  const [pending, setPending] = useState(restored.pending)
  const mutation = useMutation({
    meta: { userID: scope.userID },
    mutationFn: async (message: PendingMessage) => {
      await submitMessage({
        client: apiForUser(scope.userID),
        path: { threadID: scope.threadID },
        body: message,
        throwOnError: true,
      })
    },
  })
  const freezeMessage = (input?: {
    text: string
    assetIDs: string[]
  }): PendingMessage | string => {
    if (restored.error) return restored.error
    try {
      const frozen = input
        ? intents.message(scope.threadID, input)
        : intents.readMessage(scope.threadID)
      return (
        frozen ?? 'No saved message is available to retry. Check Chat history.'
      )
    } catch (error) {
      // Recognize only the owned storage recovery fact, never HTTP diagnostics.
      return error instanceof Error &&
        error.message === pendingIntentRecoveryMessage
        ? pendingIntentRecoveryMessage
        : 'Message could not be saved in this browser. Free browser storage before sending.'
    }
  }
  const submit = async (input?: { text: string; assetIDs: string[] }) => {
    if (mutation.isPending || !isMounted.current)
      return 'Message request is still pending.'
    const frozen = freezeMessage(input)
    if (typeof frozen === 'string') return frozen
    setPending(frozen)
    try {
      await mutation.mutateAsync(frozen)
    } catch (error) {
      return submissionError(error)
    }
    if (!isMounted.current) return ''
    // A receipt is not a persisted message. Clear the accepted draft without
    // waiting for snapshot refresh; exact replay can refer to older business IDs.
    try {
      intents.acceptMessage(scope.threadID)
    } catch {
      return 'Message accepted, but its saved request could not be removed. Check Chat history before retrying.'
    }
    setPending(undefined)
    void client.invalidateQueries(messagesQuery(scope))
    return ''
  }
  const send = (text: string, assetIDs: string[] = []) =>
    submit({ text, assetIDs })
  const retry = () => submit()
  return {
    send,
    retry,
    pending,
    hasPending: !!pending || !!restored.error,
    isBusy: mutation.isPending,
    error: restored.error,
  }
}

function submissionError(error: unknown) {
  if (error instanceof HTTPError && [401, 403, 404, 409].includes(error.status))
    return errorMessage(error)
  return 'Message acceptance is unknown. Retry the same message; do not send a replacement.'
}
